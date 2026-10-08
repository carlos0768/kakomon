import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { anthropicOptions } from '../config.ts'
import { getExam, getSpec, listExams, saveExam, updateExamStatus } from '../db/repo.ts'
import { renderExamFiles } from '../render/pdf.ts'
import { extractedExamSchema, layoutProfileSchema, passageSchema, questionSchema, type ExtractedExam } from '../schemas/exam.ts'
import { reviewResultSchema } from '../schemas/spec.ts'
import { applyRevision, batchSizeFromEnv, mergeBatch, planBatches, type GeneratedParts } from '../services/generation-plan.ts'
import { jobIdFrom, progressReporter } from '../services/job-progress.ts'
import { streamObject } from '../services/llm.ts'
import { specToMarkdown } from '../services/spec-markdown.ts'

/**
 * 予想問題の生成:
 *   generate (作問 LLM, 過去問ツール付き。分野配分を保ってバッチ生成) → review (校閲 LLM) → 必要なら改訂 (指摘分だけ再出力)
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

    const reference = inputData.referenceExamId
      ? await getExam(inputData.referenceExamId)
      : (await listExams({ kind: 'past' }))[0]
    const layout = reference?.exam.layout ?? layoutProfileSchema.parse({})
    const count = inputData.questionCount ?? spec.spec.format.questionCount
    const plans = planBatches(count, spec.spec.domains, batchSizeFromEnv())

    const generator = mastra.getAgentById('exam-generator')
    const reviewer = mastra.getAgentById('exam-reviewer')

    // 要件定義はツールで取りに行かせず本文に埋め込む (バッチごとのツール往復を減らす)
    const basePrompt = `次の出題要件定義に従い、予想問題「${inputData.title}」を作成します。
- 全体の設問数: ${count} 問、選択肢数: ${spec.spec.format.choicesPerQuestion}
- 参照する過去問: ${reference ? `examId=${reference.id} (${reference.title} ${reference.year ?? ''})` : 'なし'} を get-past-exam で読み、文体・選択肢の長さ・誤答の作り方を揃える。list-past-exams で見つかる他の回も参照してよい
- 選択肢ラベルは参照過去問と同じ表記 (例: ${reference?.exam.questions[0]?.choices.map(c => c.label).join(' ') ?? '1 2 3 4'})
${inputData.instructions ? `- 管理者からの指示: ${inputData.instructions}\n` : ''}
<要件定義 specId=${inputData.specId}>
${specToMarkdown(spec.spec, inputData.specId)}
</要件定義>`

    const acc: GeneratedParts = { passages: [], questions: [], designNotes: [] }
    const notes: string[] = []

    // 1 回分を一度に出すと出力トークン上限 (finishReason=length) に当たるため、分野配分を保ってバッチ生成する。
    // 生成・校閲はツールを持ちスキーマも大きいので、ネイティブ構造化出力 ("compiled grammar is too large") ではなく
    // スキーマをプロンプトに注入する (jsonPromptInjection: true)
    for (const plan of plans) {
      await progress.setPhase(`作問中 (${plan.index}/${plans.length} バッチ目: 問${plan.start}〜${plan.end})`)
      const done = acc.questions.map(q => ({ number: q.number, domain: q.domain, topic: q.topic, stem: q.stem.slice(0, 60) }))
      const raw = await streamObject(
        generator,
        `${basePrompt}

この呼び出しでは 問${plan.start}〜問${plan.end} の ${plan.end - plan.start + 1} 問だけを作成してください (全 ${plans.length} バッチ中 ${plan.index} 番目)。
- この範囲の分野配分: ${plan.quota.map(q => `${q.domain} ${q.count} 問`).join('、')}
- number は ${plan.start} から連番
- 長文読解の本文など複数の設問で共有する資料文は passages に 1 回だけ書き、id は "P${plan.index}-1" のようにこのバッチ固有の接頭辞を付け、設問は passageId で参照する。設問ごとに同じ本文を繰り返さない
- title / instructions は不要。passages / questions / designNotes だけを JSON で出力
${done.length ? `- すでに作成済みの設問 (題材・問い方の重複を避ける):\n${JSON.stringify(done)}` : ''}`,
        {
          structuredOutput: { schema: generatedBatchSchema, jsonPromptInjection: true },
          maxSteps: 60,
          modelSettings: { maxOutputTokens: 32000 },
          providerOptions: anthropicOptions('xhigh'),
        },
        { progress },
      )
      notes.push(...mergeBatch(acc, generatedBatchSchema.parse(raw), plan))
    }
    if (!acc.questions.length) throw new Error('作問結果が空でした')

    let revisions = 0
    let review = await runReview()
    while (!review.approved && revisions < inputData.maxRevisions) {
      revisions++
      await progress.setPhase(`校閲の指摘を反映して改訂中 (${revisions} 回目)`)
      const issues = review.issues
        .map(i => `- [${i.severity}/${i.category}] ${i.questionNumber ? `問${i.questionNumber}: ` : ''}${i.message}${i.suggestion ? ` → ${i.suggestion}` : ''}`)
        .join('\n')
      const raw = await streamObject(
        generator,
        `${basePrompt}

現在の草案 (JSON):
${JSON.stringify({ passages: acc.passages, questions: acc.questions })}

校閲者から次の指摘がありました。
${issues}

指摘された設問だけを修正 (必要なら同じ number で差し替え) して出力してください。指摘のない設問は出力しないでください。
資料文を直す場合は同じ id で passages に含めてください。出力は passages / questions / designNotes の JSON のみ。`,
        {
          structuredOutput: { schema: revisionSchema, jsonPromptInjection: true },
          maxSteps: 60,
          modelSettings: { maxOutputTokens: 32000 },
          providerOptions: anthropicOptions('xhigh'),
        },
        { progress },
      )
      notes.push(...applyRevision(acc, revisionSchema.parse(raw)))
      review = await runReview()
    }

    const generated = generatedExamSchema.parse({
      title: inputData.title,
      instructions: reference?.exam.instructions ?? [],
      timeLimitMinutes: spec.spec.format.timeLimitMinutes ?? reference?.exam.timeLimitMinutes,
      passages: acc.passages,
      questions: acc.questions,
      designNotes: acc.designNotes.join('\n'),
      notes,
    })
    return { input: inputData, generated, review, revisions, layout, referenceExamId: reference?.id }

    async function runReview() {
      await progress.setPhase('校閲中 (要件定義と過去問に照らして検査)')
      const raw = await streamObject(
        reviewer,
        `次の予想問題を要件定義 specId=${inputData.specId} と過去問に照らして検査してください。

予想問題 (JSON):
${JSON.stringify({ title: inputData.title, passages: acc.passages, questions: acc.questions })}`,
        {
          structuredOutput: { schema: reviewResultSchema, jsonPromptInjection: true },
          maxSteps: 40,
          modelSettings: { maxOutputTokens: 16000 },
          providerOptions: anthropicOptions('high'),
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
      questions: inputData.generated.questions,
      layout: inputData.layout,
      extractionNotes: [`generated from spec ${inputData.input.specId}`, ...inputData.generated.notes, inputData.generated.designNotes].filter(Boolean),
    })
    const rec = await saveExam({ kind: 'predicted', exam, status: 'review', specId: inputData.input.specId })
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
