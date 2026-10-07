import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { anthropicOptions } from '../config.ts'
import { listExams, saveSpec } from '../db/repo.ts'
import { examSpecSchema } from '../schemas/spec.ts'

/**
 * 出題傾向分析 → 出題要件定義 (ExamSpec) の作成。
 * アナリストはツールで過去問を読み込むため、プロンプトに全文を貼らない。
 */

const inputSchema = z.object({
  examIds: z.array(z.string()).optional().describe('分析対象の過去問 ID (省略で登録済みの過去問すべて)'),
  title: z.string().optional().describe('試験名 (要件定義のタイトル)'),
  focus: z.string().optional().describe('管理者からの追加指示 (例: 直近 3 年を重視)'),
  specId: z.string().optional().describe('既存の要件定義を上書きする場合の ID'),
})

const analyzeStep = createStep({
  id: 'analyze-trends',
  inputSchema,
  outputSchema: z.object({ input: inputSchema, spec: examSpecSchema }),
  execute: async ({ inputData, mastra }) => {
    const exams = await listExams({ kind: 'past' })
    const targets = inputData.examIds?.length ? exams.filter(e => inputData.examIds!.includes(e.id)) : exams
    if (targets.length === 0) throw new Error('分析対象の過去問が登録されていません。先に ingest を実行してください')

    const agent = mastra.getAgentById('exam-analyst')
    const list = targets
      .map(e => `- examId=${e.id} / ${e.title} / ${e.year ?? '年度不明'} ${e.session ?? ''} / ${e.exam.questions.length}問`)
      .join('\n')
    const result = await agent.generate(
      `次の過去問を分析し、出題要件定義を作成してください。
対象:
${list}
${inputData.title ? `\n試験名: ${inputData.title}` : ''}
${inputData.focus ? `\n管理者からの指示: ${inputData.focus}` : ''}

sourceExamIds には上記の examId をすべて入れてください。`,
      {
        structuredOutput: { schema: examSpecSchema, jsonPromptInjection: 'auto' },
        maxSteps: 40,
        modelSettings: { maxOutputTokens: 32000 },
        providerOptions: anthropicOptions('high'),
      },
    )
    const spec = examSpecSchema.parse(result.object)
    if (inputData.title) spec.title = inputData.title
    spec.sourceExamIds = targets.map(e => e.id)
    return { input: inputData, spec }
  },
})

const saveStep = createStep({
  id: 'save-spec',
  inputSchema: analyzeStep.outputSchema,
  outputSchema: z.object({
    specId: z.string(),
    title: z.string(),
    summary: z.string(),
    domains: z.array(z.object({ domain: z.string(), share: z.number(), expectedCount: z.number() })),
    forecast: examSpecSchema.shape.forecast,
  }),
  execute: async ({ inputData }) => {
    const rec = await saveSpec({ id: inputData.input.specId, spec: inputData.spec, status: 'draft' })
    return {
      specId: rec.id,
      title: rec.title,
      summary: rec.spec.summary,
      domains: rec.spec.domains.map(d => ({ domain: d.domain, share: d.share, expectedCount: d.expectedCount })),
      forecast: rec.spec.forecast,
    }
  },
})

export const analyzeExamWorkflow = createWorkflow({
  id: 'analyze-exam',
  description: '過去問の出題傾向と作問方法を分析し、出題要件定義を作成する',
  inputSchema,
  outputSchema: saveStep.outputSchema,
})
  .then(analyzeStep)
  .then(saveStep)
  .commit()
