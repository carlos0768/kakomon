import { randomUUID } from 'node:crypto'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { anthropicOptions, config } from '../config.ts'
import { getExam, getSpec, listExams, saveExam, updateExamStatus } from '../db/repo.ts'
import { renderExamFiles } from '../render/pdf.ts'
import { extractedExamSchema, layoutProfileSchema, passageSchema, questionSchema, sectionSchema, type ExtractedExam, type Question } from '../schemas/exam.ts'
import { reviewResultSchema, type ReviewResult } from '../schemas/spec.ts'
import { describeSections } from '../services/exam-structure.ts'
import {
  applyRevision,
  batchSizeFromEnv,
  checkSectionStructure,
  mergeBatch,
  orderBySections,
  planBatches,
  planSectionBatches,
  sortIntoSections,
  type BatchPlan,
  type GeneratedParts,
  type SectionSlot,
} from '../services/generation-plan.ts'
import { setExamScope } from '../services/exam-scope.ts'
import { jobIdFrom, progressReporter, rethrowIfCancelled } from '../services/job-progress.ts'
import { streamObject } from '../services/llm.ts'
import { specToMarkdown } from '../services/spec-markdown.ts'

/**
 * 予想問題の生成:
 *   generate (作問 LLM, 過去問ツール付き。大問構成があれば大問単位、なければ分野配分を保ってバッチ生成)
 *   → 大問構成の検査 (コード) + review (校閲 LLM) → 必要なら改訂 (指摘分だけ再出力)
 *   → 下書き保存 → 管理者承認 (suspend) → レンダリング (HTML/PDF) → 公開
 */

const inputSchema = z.object({
  specId: z.string().describe('出題要件定義 ID'),
  title: z.string().describe('予想問題のタイトル (例: 2026年度 予想問題 第1回)'),
  referenceExamId: z.string().optional().describe('見た目を真似る過去問 ID (省略で最新年度)'),
  questionCount: z.number().int().min(1).optional().describe('設問数 (省略で要件定義どおり)'),
  instructions: z.string().optional().describe('管理者からの追加指示'),
  maxRevisions: z.number().int().min(0).max(3).default(1),
})

/** 作問 LLM の 1 バッチ分の出力。タイトル・注意書きは参照過去問から引き継ぐので含めない */
const generatedBatchSchema = z.object({
  passages: z.array(passageSchema).default([]).describe('複数の設問で共有する資料文 (1 回だけ記述)'),
  questions: z.array(questionSchema).min(1),
  /** 設計メモ: 分野・難易度の割り付けと意図 */
  designNotes: z.string().default(''),
})

/** 校閲後の改訂出力: 指摘された設問だけを再出力する */
const revisionSchema = z.object({
  passages: z.array(passageSchema).default([]),
  questions: z.array(questionSchema).default([]),
  designNotes: z.string().default(''),
})

/** バッチをマージした 1 回分 */
const generatedExamSchema = z.object({
  title: z.string(),
  instructions: z.array(z.string()).default([]),
  timeLimitMinutes: z.number().int().optional(),
  passages: z.array(passageSchema).default([]),
  sections: z.array(sectionSchema).default([]),
  questions: z.array(questionSchema).min(1),
  designNotes: z.string(),
  /** 生成時に気づいた点 (バッチの過不足など) */
  notes: z.array(z.string()).default([]),
})

const generateStep = createStep({
  id: 'generate-questions',
  inputSchema,
  outputSchema: z.object({
    input: inputSchema,
    /** バッチごとに保存している下書きの ID (途中で失敗しても残る) */
    examId: z.string(),
    generated: generatedExamSchema,
    review: reviewResultSchema,
    revisions: z.number().int(),
    layout: layoutProfileSchema,
    referenceExamId: z.string().optional(),
  }),
  execute: async ({ inputData, mastra, requestContext }) => {
    const progress = progressReporter(jobIdFrom(requestContext), '作問の準備中')
    await progress.flush()
    const spec = await getSpec(inputData.specId)
    if (!spec) throw new Error(`要件定義が見つかりません: ${inputData.specId}`)

    // 参照過去問の既定は「要件定義の元になった過去問のうち最新」。別の試験の過去問が登録されていても混ざらない。
    // 元の過去問がすべて削除されていたら参照なしにする (無関係な試験の過去問に切り替えない)
    const pastExams = await listExams({ kind: 'past' })
    const reference = inputData.referenceExamId
      ? await getExam(inputData.referenceExamId)
      : (pastExams.find(e => spec.spec.sourceExamIds.includes(e.id)) ?? (spec.spec.sourceExamIds.length ? undefined : pastExams[0]))
    // 作問・校閲のツール (一覧・検索・取得) が読める過去問を、要件定義の元の過去問 + 参照過去問 +
    // 同じ要件定義から作った予想問題 (重複出題の確認用) に限定する
    const scope = [...new Set([...spec.spec.sourceExamIds, ...(reference ? [reference.id] : []), ...(await listExams({ kind: 'predicted' })).filter(e => e.specId === inputData.specId).map(e => e.id)])]
    if (requestContext && scope.length) setExamScope(requestContext, scope)
    const layout = reference?.exam.layout ?? layoutProfileSchema.parse({})
    const notes: string[] = []

    // 大問構成があれば大問単位で計画する (大問の数・小問数を守らせるため)。
    // 管理者が構成と合わない設問数を指定した場合だけ、その指定を優先して従来の分野配分で作る
    const specSections = spec.spec.format.sections
    const sectionTotal = specSections.reduce((n, sec) => n + sec.questionCount, 0)
    const useSections = specSections.length > 0 && (inputData.questionCount === undefined || inputData.questionCount === sectionTotal)
    if (specSections.length && !useSections) {
      notes.push(`設問数の指定 (${inputData.questionCount} 問) が大問構成の合計 (${sectionTotal} 問) と異なるため、大問構成を使わずに作問`)
    }
    const sections = useSections ? specSections : []
    const count = useSections ? sectionTotal : (inputData.questionCount ?? spec.spec.format.questionCount)
    const plans = useSections ? planSectionBatches(sections, batchSizeFromEnv()) : planBatches(count, spec.spec.domains, batchSizeFromEnv())
    const examSections = sections.map(sec => ({ number: sec.number, title: sec.title, instruction: sec.instruction }))

    const generator = mastra.getAgentById('exam-generator')
    const reviewer = mastra.getAgentById('exam-reviewer')

    // 要件定義はツールで取りに行かせず本文に埋め込む (バッチごとのツール往復を減らす)
    const basePrompt = `次の出題要件定義に従い、予想問題「${inputData.title}」を作成します。
- 全体の設問数: ${count} 問、選択肢数: ${spec.spec.format.choicesPerQuestion}
- 参照する過去問: ${reference ? `examId=${reference.id} (${reference.title} ${reference.year ?? ''})` : 'なし'} を get-past-exam で読み、文体・選択肢の長さ・誤答の作り方を揃える。list-past-exams で見つかる他の回も参照してよい
- 選択肢ラベルは参照過去問と同じ表記 (例: ${reference?.exam.questions[0]?.choices.map(c => c.label).join(' ') ?? '1 2 3 4'})
${sections.length ? `- 大問構成 (厳守): ${describeSections(sections)}。大問の数と各大問の小問数を変えない。各設問の section に所属する大問の番号を入れる\n` : ''}${inputData.instructions ? `- 管理者からの指示: ${inputData.instructions}\n` : ''}
<要件定義 specId=${inputData.specId}>
${specToMarkdown(spec.spec, inputData.specId)}
</要件定義>`

    const acc: GeneratedParts = { passages: [], questions: [], designNotes: [] }
    const examId = randomUUID()

    // バッチが 1 つ終わるごとに下書きを DB に保存する。後続 (校閲・改訂) で失敗しても生成済みの設問は残る
    const persistDraft = async (status: 'draft' | 'review', extraNotes: string[] = []) => {
      if (!acc.questions.length) return
      await saveExam({
        id: examId,
        kind: 'predicted',
        status,
        specId: inputData.specId,
        exam: extractedExamSchema.parse({
          title: inputData.title,
          year: new Date().getFullYear(),
          session: '予想',
          timeLimitMinutes: spec.spec.format.timeLimitMinutes ?? reference?.exam.timeLimitMinutes,
          instructions: reference?.exam.instructions ?? [],
          passages: acc.passages,
          sections: examSections,
          questions: acc.questions,
          layout,
          extractionNotes: [`generated from spec ${inputData.specId}`, ...extraNotes, ...notes, acc.designNotes.join('\n')].filter(Boolean),
        }),
      })
    }

    // 1 回分を一度に出すと出力トークン上限 (finishReason=length) に当たるため、分野配分を保ってバッチ生成する。
    // 生成・校閲はツールを持ちスキーマも大きいので、ネイティブ構造化出力 ("compiled grammar is too large") ではなく
    // スキーマをプロンプトに注入する (jsonPromptInjection: true)
    for (const plan of plans) {
      const start = acc.questions.length + 1
      const size = plan.end - plan.start + 1
      await progress.setPhase(`作問中 (${plan.index}/${plans.length} バッチ目: 問${start}〜${start + size - 1})`)
      const done = acc.questions.map(q => ({ number: q.number, section: q.section, domain: q.domain, topic: q.topic, stem: q.stem.slice(0, 60) }))
      const batch = generatedBatchSchema.parse(
        await generate(`この呼び出しでは 問${start}〜問${start + size - 1} の ${size} 問だけを作成してください (全 ${plans.length} バッチ中 ${plan.index} 番目)。
${plan.sections ? sectionAssignment(plan.sections, start) : `- この範囲の分野配分: ${plan.quota.map(q => `${q.domain} ${q.count} 問`).join('、')}\n- number は ${start} から連番`}
- 長文読解の本文など複数の設問で共有する資料文は passages に 1 回だけ書き、id は "P${plan.index}-1" のようにこのバッチ固有の接頭辞を付け、設問は passageId で参照する。設問ごとに同じ本文を繰り返さない
- title / instructions は不要。passages / questions / designNotes だけを JSON で出力
${done.length ? `- すでに作成済みの設問 (題材・問い方の重複を避ける):\n${JSON.stringify(done)}` : ''}`),
      )
      if (plan.sections) batch.questions = await fitToSections(plan, batch)
      notes.push(...mergeBatch(acc, batch, plan))
      await persistDraft('draft', [`生成中 (${plan.index}/${plans.length} バッチ完了)`])
    }
    if (!acc.questions.length) throw new Error('作問結果が空でした')

    // 校閲と改訂は「失敗しても下書きを捨てない」。失敗は注意書きとして残し、管理者の確認に回す
    let revisions = 0
    let review = await runReviewSafely()
    // 改訂は設問の差し替えなので、設問番号の付いた指摘がなければ回さない (大問の構成違反だけなら管理者確認へ)
    while (!review.approved && revisions < inputData.maxRevisions && review.issues.some(i => i.questionNumber !== undefined)) {
      revisions++
      await progress.setPhase(`校閲の指摘を反映して改訂中 (${revisions} 回目)`)
      const flagged = new Set(review.issues.map(i => i.questionNumber).filter((n): n is number => typeof n === 'number'))
      const targets = acc.questions.filter(q => flagged.has(q.number))
      const passageIds = new Set(targets.map(q => q.passageId).filter(Boolean))
      const issues = review.issues
        .map(i => `- [${i.severity}/${i.category}] ${i.questionNumber ? `問${i.questionNumber}: ` : ''}${i.message}${i.suggestion ? ` → ${i.suggestion}` : ''}`)
        .join('\n')
      try {
        // 全体を送らず、指摘された設問とその資料文、それ以外は見出しだけを渡す (入力と思考を減らす)
        const raw = await streamObject(
          generator,
          `${basePrompt}

校閲者から次の指摘がありました。
${issues}

指摘された設問 (JSON):
${JSON.stringify({ passages: acc.passages.filter(p => passageIds.has(p.id)), questions: targets })}

それ以外の設問の一覧 (重複を避けるための参考。出力しない):
${JSON.stringify(acc.questions.filter(q => !flagged.has(q.number)).map(q => ({ number: q.number, domain: q.domain, topic: q.topic, stem: q.stem.slice(0, 60) })))}

指摘された設問だけを修正 (必要なら同じ number で差し替え) して出力してください。指摘のない設問は出力しないでください。
資料文を直す場合は同じ id で passages に含めてください。出力は passages / questions / designNotes の JSON のみ。`,
          {
            requestContext,
            structuredOutput: { schema: revisionSchema, jsonPromptInjection: true },
            maxSteps: 60,
            // 思考トークンも上限に含まれるため、出力 (~1.5 万) + 思考の余裕を取る
            modelSettings: { maxOutputTokens: 64000 },
            providerOptions: anthropicOptions(config.generateEffort),
          },
          { progress },
        )
        notes.push(...applyRevision(acc, revisionSchema.parse(raw)))
        await persistDraft('draft', [`改訂 ${revisions} 回目を反映`])
      } catch (err) {
        rethrowIfCancelled(err)
        notes.push(`改訂 ${revisions} 回目に失敗したため、校閲前の内容のまま管理者確認に回します: ${err instanceof Error ? err.message : String(err)}`)
        break
      }
      review = await runReviewSafely()
    }

    const generated = generatedExamSchema.parse({
      title: inputData.title,
      instructions: reference?.exam.instructions ?? [],
      timeLimitMinutes: spec.spec.format.timeLimitMinutes ?? reference?.exam.timeLimitMinutes,
      passages: acc.passages,
      sections: examSections,
      questions: acc.questions,
      designNotes: acc.designNotes.join('\n'),
      notes,
    })
    return { input: inputData, examId, generated, review, revisions, layout, referenceExamId: reference?.id }

    /** 作問 LLM を 1 回呼ぶ (バッチ作成・追加作問で共通) */
    async function generate(task: string) {
      return await streamObject(generator, `${basePrompt}\n\n${task}`, {
        requestContext,
        structuredOutput: { schema: generatedBatchSchema, jsonPromptInjection: true },
        maxSteps: 60,
        // 思考トークンも上限に含まれる (15 問の出力 ~1.5 万 + 思考)
        modelSettings: { maxOutputTokens: 64000 },
        providerOptions: anthropicOptions(config.generateEffort),
      }, { progress })
    }

    /** バッチが受け持つ大問と小問数の割り当て (作問 LLM への指示) */
    function sectionAssignment(slots: SectionSlot[], start: number) {
      // 前のバッチから続く大問は、その大問ですでに作った資料文を渡して同じ passageId で参照させる
      const continued = new Set(slots.filter(sl => sl.from > 1).map(sl => sl.section))
      const ids = new Set(acc.questions.filter(q => q.section !== undefined && continued.has(q.section)).map(q => q.passageId))
      const shared = acc.passages.filter(p => ids.has(p.id))
      return `- この範囲の大問と小問数 (厳守。この数だけ作り、大問の順に並べる):
${slots
  .map(sl => {
    const range = sl.count === sl.total ? `小問 ${sl.count} 問` : `小問 ${sl.from}〜${sl.from + sl.count - 1} 問目 (全 ${sl.total} 問のうち ${sl.count} 問)`
    const extra = [
      sl.instruction ? `指示文「${sl.instruction}」` : '',
      sl.domains.length ? `分野: ${sl.domains.join('・')}` : '',
      sl.sharedPassage ? '小問はすべて 1 つの共通の資料文を参照する' : '',
      sl.notes ?? '',
    ].filter(Boolean)
    return `  - section=${sl.section} (${sl.title || `第${sl.section}問`}): ${range}${extra.length ? ` / ${extra.join(' / ')}` : ''}`
  })
  .join('\n')}
- 各設問の section に上の大問番号を入れる。number は ${start} から大問の順に連番
${shared.length ? `- 前のバッチから続く大問の資料文 (同じ id を passageId で参照し、passages には再掲しない):\n${JSON.stringify(shared)}` : ''}`
    }

    /**
     * 作問結果を大問ごとの枠に振り分け、足りない大問があれば 1 回だけ追加作問して埋める。
     * それでも足りなければメモに残す (大問構成の検査で管理者に示される)。
     */
    async function fitToSections(plan: BatchPlan, batch: z.infer<typeof generatedBatchSchema>): Promise<Question[]> {
      const slots = plan.sections!
      const fit = sortIntoSections(batch.questions, slots)
      if (fit.dropped) notes.push(`バッチ ${plan.index}: 大問の小問数を超えた ${fit.dropped} 問を切り捨て`)
      if (fit.missing.length) {
        const lacking = fit.missing.map(m => `${m.slot.title || `第${m.slot.section}問`} があと ${m.count} 問`).join('、')
        await progress.setPhase(`作問中 (${plan.index}/${plans.length} バッチ目: 不足した小問を追加作成)`)
        try {
          const made = [...fit.picked.values()].flat().map(q => ({ section: q.section, topic: q.topic, stem: q.stem.slice(0, 60) }))
          const extra = generatedBatchSchema.parse(
            await generate(`大問の小問数が足りません (${lacking})。不足分の小問だけを作成してください。
${fit.missing.map(m => `- section=${m.slot.section} (${m.slot.title || `第${m.slot.section}問`}): ${m.count} 問${m.slot.domains.length ? ` / 分野: ${m.slot.domains.join('・')}` : ''}`).join('\n')}
- 各設問の section に上の大問番号を入れる (number は仮でよい。結合時に振り直す)
- この大問ですでに作成した小問と、使っている資料文 (同じ資料文を使う場合は同じ id を passageId で参照し、passages には再掲しない):
${JSON.stringify({ passages: batch.passages, questions: made })}
- 新しい資料文が必要なら id は "P${plan.index}-T1" のように付ける
- passages / questions / designNotes だけを JSON で出力`),
          )
          sortIntoSections(extra.questions, slots, fit.picked)
          batch.passages.push(...extra.passages.filter(p => !batch.passages.some(x => x.id === p.id)))
        } catch (err) {
          notes.push(`バッチ ${plan.index}: 不足した小問の追加作成に失敗: ${err instanceof Error ? err.message : String(err)}`)
        }
        const still = slots
          .map(sl => ({ sl, n: sl.count - (fit.picked.get(sl.section)?.length ?? 0) }))
          .filter(x => x.n > 0)
        if (still.length) notes.push(`バッチ ${plan.index}: 小問が不足したまま (${still.map(x => `${x.sl.title || `第${x.sl.section}問`} ${x.n} 問`).join('、')})`)
      }
      return orderBySections(fit.picked, slots)
    }

    async function runReviewSafely(): Promise<ReviewResult> {
      let review: ReviewResult
      try {
        review = await runReview()
      } catch (err) {
        rethrowIfCancelled(err)
        const message = `校閲に失敗したため未校閲のまま管理者確認に回します: ${err instanceof Error ? err.message : String(err)}`
        notes.push(message)
        review = reviewResultSchema.parse({
          overallScore: 0,
          approved: false,
          issues: [{ severity: 'major', category: 'その他', message }],
          coverage: { domainCoverage: '未評価', difficultyCoverage: '未評価', patternCoverage: '未評価' },
        })
      }
      // 大問構成は LLM の校閲に任せず、数えて検査する。違反は出題不可 (blocker)
      const problems = checkSectionStructure(acc.questions, sections)
      if (!problems.length) return review
      return {
        ...review,
        approved: false,
        issues: [...problems.map(message => ({ severity: 'blocker' as const, category: '要件逸脱' as const, message: `大問構成: ${message}` })), ...review.issues],
      }
    }

    async function runReview() {
      await progress.setPhase('校閲中 (要件定義と過去問に照らして検査)')
      const raw = await streamObject(
        reviewer,
        `次の予想問題を要件定義 specId=${inputData.specId} と過去問に照らして検査してください。

予想問題 (JSON):
${JSON.stringify({ title: inputData.title, passages: acc.passages, sections: examSections, questions: acc.questions })}`,
        {
          requestContext,
          structuredOutput: { schema: reviewResultSchema, jsonPromptInjection: true },
          maxSteps: 40,
          modelSettings: { maxOutputTokens: 16000 },
          providerOptions: anthropicOptions('medium'),
        },
        { progress },
      )
      return reviewResultSchema.parse(raw)
    }
  },
})

const saveDraftStep = createStep({
  id: 'save-draft',
  inputSchema: generateStep.outputSchema,
  outputSchema: z.object({
    examId: z.string(),
    title: z.string(),
    questionCount: z.number().int(),
    review: reviewResultSchema,
    revisions: z.number().int(),
    designNotes: z.string(),
  }),
  execute: async ({ inputData }) => {
    const exam: ExtractedExam = extractedExamSchema.parse({
      title: inputData.generated.title || inputData.input.title,
      year: new Date().getFullYear(),
      session: '予想',
      timeLimitMinutes: inputData.generated.timeLimitMinutes,
      instructions: inputData.generated.instructions,
      passages: inputData.generated.passages,
      sections: inputData.generated.sections,
      questions: inputData.generated.questions,
      layout: inputData.layout,
      extractionNotes: [`generated from spec ${inputData.input.specId}`, ...inputData.generated.notes, inputData.generated.designNotes].filter(Boolean),
    })
    // 生成中にバッチごとに保存してきた下書き (examId) を最終内容で更新し、承認待ちにする
    const rec = await saveExam({ id: inputData.examId, kind: 'predicted', exam, status: 'review', specId: inputData.input.specId })
    return {
      examId: rec.id,
      title: rec.title,
      questionCount: rec.exam.questions.length,
      review: inputData.review,
      revisions: inputData.revisions,
      designNotes: inputData.generated.designNotes,
    }
  },
})

/** 管理者承認ゲート。承認されるまで suspend し、Studio / CLI / API から resume する */
export const adminApprovalStep = createStep({
  id: 'admin-approval',
  inputSchema: saveDraftStep.outputSchema,
  suspendSchema: z.object({
    examId: z.string(),
    title: z.string(),
    questionCount: z.number().int(),
    reviewScore: z.number(),
    reviewApproved: z.boolean(),
    blockerCount: z.number().int(),
    message: z.string(),
  }),
  resumeSchema: z.object({
    approved: z.boolean().describe('true で公開、false で破棄 (archived)'),
    note: z.string().optional(),
  }),
  outputSchema: z.object({ examId: z.string(), approved: z.boolean(), note: z.string().optional() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      const blockerCount = inputData.review.issues.filter(i => i.severity === 'blocker').length
      return await suspend({
        examId: inputData.examId,
        title: inputData.title,
        questionCount: inputData.questionCount,
        reviewScore: inputData.review.overallScore,
        reviewApproved: inputData.review.approved,
        blockerCount,
        message: `管理者レビュー待ち: data/out/${inputData.examId}-answers.html で内容を確認し、approved=true/false で resume してください`,
      })
    }
    if (!resumeData.approved) await updateExamStatus(inputData.examId, 'archived')
    return { examId: inputData.examId, approved: resumeData.approved, note: resumeData.note }
  },
})

/** 下書き保存直後にプレビュー (解答付き HTML) を出力して、管理者が確認できるようにする */
const previewStep = createStep({
  id: 'render-preview',
  inputSchema: saveDraftStep.outputSchema,
  outputSchema: saveDraftStep.outputSchema,
  execute: async ({ inputData }) => {
    const rec = await getExam(inputData.examId)
    if (rec) await renderExamFiles(rec.id, rec.exam, { withAnswers: true })
    return inputData
  },
})

const publishStep = createStep({
  id: 'render-and-publish',
  inputSchema: adminApprovalStep.outputSchema,
  outputSchema: z.object({
    examId: z.string(),
    status: z.enum(['published', 'archived']),
    htmlPath: z.string().optional(),
    pdfPath: z.string().optional(),
    pdfSkippedReason: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData.approved) return { examId: inputData.examId, status: 'archived' as const }
    const rec = await getExam(inputData.examId)
    if (!rec) throw new Error(`exam not found: ${inputData.examId}`)
    const files = await renderExamFiles(rec.id, rec.exam)
    await renderExamFiles(rec.id, rec.exam, { withAnswers: true })
    await updateExamStatus(rec.id, 'published')
    return { examId: rec.id, status: 'published' as const, ...files }
  },
})

export const generateExamWorkflow = createWorkflow({
  id: 'generate-exam',
  description: '出題要件定義から予想問題を生成し、校閲 → 管理者承認 → 見た目を再現した HTML/PDF を出力して公開する',
  inputSchema,
  outputSchema: publishStep.outputSchema,
})
  .then(generateStep)
  .then(saveDraftStep)
  .then(previewStep)
  .then(adminApprovalStep)
  .then(publishStep)
  .commit()
