import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { anthropicOptions } from '../config.ts'
import { getExam, getSpec, listExams, saveExam, updateExamStatus } from '../db/repo.ts'
import { renderExamFiles } from '../render/pdf.ts'
import { extractedExamSchema, layoutProfileSchema, questionSchema, type ExtractedExam } from '../schemas/exam.ts'
import { reviewResultSchema } from '../schemas/spec.ts'

/**
 * 予想問題の生成:
 *   generate (作問 LLM, 過去問ツール付き) → review (校閲 LLM) → 必要なら 1 回改訂
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

/** 作問 LLM の出力 (レイアウトは参照過去問からコピーするので含めない) */
const generatedExamSchema = z.object({
  title: z.string(),
  instructions: z.array(z.string()).default([]),
  timeLimitMinutes: z.number().int().optional(),
  questions: z.array(questionSchema).min(1),
  /** 設計メモ: 分野・難易度の割り付けと意図 */
  designNotes: z.string(),
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
  execute: async ({ inputData, mastra }) => {
    const spec = await getSpec(inputData.specId)
    if (!spec) throw new Error(`要件定義が見つかりません: ${inputData.specId}`)

    const reference = inputData.referenceExamId
      ? await getExam(inputData.referenceExamId)
      : (await listExams({ kind: 'past' }))[0]
    const layout = reference?.exam.layout ?? layoutProfileSchema.parse({})
    const count = inputData.questionCount ?? spec.spec.format.questionCount

    const generator = mastra.getAgentById('exam-generator')
    const reviewer = mastra.getAgentById('exam-reviewer')

    const basePrompt = `要件定義 specId=${inputData.specId} (get-exam-spec で取得) に従い、予想問題を 1 回分作成してください。
- タイトル: ${inputData.title}
- 設問数: ${count} 問、選択肢数: ${spec.spec.format.choicesPerQuestion}
- 参照する過去問: ${reference ? `examId=${reference.id} (${reference.title} ${reference.year ?? ''})` : 'なし'} を中心に、list-past-exams で見つかる他の回も参照すること
- 選択肢ラベルは参照過去問と同じ表記 (例: ${reference?.exam.questions[0]?.choices.map(c => c.label).join(' ') ?? '1 2 3 4'})
${inputData.instructions ? `- 管理者からの指示: ${inputData.instructions}` : ''}`

    let generated = generatedExamSchema.parse(
      (
        await generator.generate(basePrompt, {
          structuredOutput: { schema: generatedExamSchema, jsonPromptInjection: 'auto' },
          maxSteps: 60,
          modelSettings: { maxOutputTokens: 64000 },
          providerOptions: anthropicOptions('xhigh'),
        })
      ).object,
    )

    let revisions = 0
    let review = await runReview()
    while (!review.approved && revisions < inputData.maxRevisions) {
      revisions++
      const issues = review.issues
        .map(i => `- [${i.severity}/${i.category}] ${i.questionNumber ? `問${i.questionNumber}: ` : ''}${i.message}${i.suggestion ? ` → ${i.suggestion}` : ''}`)
        .join('\n')
      generated = generatedExamSchema.parse(
        (
          await generator.generate(
            `${basePrompt}

前回の草案 (JSON):
${JSON.stringify(generated)}

校閲者から次の指摘がありました。指摘された設問を修正し (必要なら差し替え)、指摘のない設問は原則そのまま残して、完全な 1 回分を再出力してください。
${issues}`,
            {
              structuredOutput: { schema: generatedExamSchema, jsonPromptInjection: 'auto' },
              maxSteps: 60,
              modelSettings: { maxOutputTokens: 64000 },
              providerOptions: anthropicOptions('xhigh'),
            },
          )
        ).object,
      )
      review = await runReview()
    }

    return { input: inputData, generated, review, revisions, layout, referenceExamId: reference?.id }

    async function runReview() {
      const res = await reviewer.generate(
        `次の予想問題を要件定義 specId=${inputData.specId} と過去問に照らして検査してください。

予想問題 (JSON):
${JSON.stringify(generated)}`,
        {
          structuredOutput: { schema: reviewResultSchema, jsonPromptInjection: 'auto' },
          maxSteps: 40,
          modelSettings: { maxOutputTokens: 16000 },
          providerOptions: anthropicOptions('high'),
        },
      )
      return reviewResultSchema.parse(res.object)
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
      questions: inputData.generated.questions,
      layout: inputData.layout,
      extractionNotes: [`generated from spec ${inputData.input.specId}`, inputData.generated.designNotes],
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
