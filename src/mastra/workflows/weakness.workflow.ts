import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { anthropicOptions } from '../config.ts'
import { getExam, getSpec, listAttempts, saveWeaknessReport, type ExamRecord } from '../db/repo.ts'
import { coachingSchema, weaknessReportSchema } from '../schemas/grading.ts'
import { streamObject } from '../services/llm.ts'
import { computeWeakness } from '../services/weakness.ts'

/**
 * 弱点分析: 2 回分以上の受験結果を集計 (コード) → LLM が原因と学習計画を言語化 → 保存。
 */

const inputSchema = z.object({ userId: z.string() })

const aggregateStep = createStep({
  id: 'aggregate-results',
  inputSchema,
  outputSchema: z.object({
    report: weaknessReportSchema,
    wrongExamples: z.array(z.object({ examTitle: z.string(), questionNumber: z.number(), topic: z.string(), stem: z.string(), selected: z.string().nullable(), correct: z.string() })),
  }),
  execute: async ({ inputData }) => {
    const attempts = await listAttempts(inputData.userId, 'submitted')
    const exams = new Map<string, ExamRecord>()
    for (const a of attempts) {
      if (!exams.has(a.examId)) {
        const e = await getExam(a.examId)
        if (e) exams.set(a.examId, e)
      }
    }
    // 直近に受けた予想問題の要件定義を重み付けに使う
    const specId = [...exams.values()].map(e => e.specId).filter(Boolean).at(-1)
    const spec = specId ? (await getSpec(specId))?.spec : undefined
    const report = computeWeakness({ userId: inputData.userId, attempts, exams, spec })

    const wrongExamples = attempts
      .flatMap(a =>
        a.result!.feedback
          .filter(f => !f.correct)
          .map(f => {
            const e = exams.get(a.examId)
            const q = e?.exam.questions.find(q => q.number === f.questionNumber)
            return {
              examTitle: e?.title ?? a.examId,
              questionNumber: f.questionNumber,
              topic: f.topic,
              stem: (q?.stem ?? '').slice(0, 200),
              selected: f.selectedLabel,
              correct: f.correctLabel,
            }
          }),
      )
      .slice(0, 30)
    return { report, wrongExamples }
  },
})

const coachStep = createStep({
  id: 'coach-with-llm',
  inputSchema: aggregateStep.outputSchema,
  outputSchema: weaknessReportSchema,
  execute: async ({ inputData, mastra }) => {
    const { report, wrongExamples } = inputData
    const agent = mastra.getAgentById('exam-coach')
    try {
      const raw = await streamObject(
        agent,
        `受験者の成績集計です。summary / rootCauses / studyPlan を作成してください。

集計 (JSON):
${JSON.stringify({ ...report, coaching: undefined })}

誤答した設問の例:
${JSON.stringify(wrongExamples)}`,
        {
          structuredOutput: { schema: coachingSchema, jsonPromptInjection: 'auto' },
          modelSettings: { maxOutputTokens: 8000 },
          providerOptions: anthropicOptions('medium'),
        },
      )
      report.coaching = coachingSchema.parse(raw)
    } catch (err) {
      report.coaching = {
        summary: `講評の生成に失敗しました (${err instanceof Error ? err.message : String(err)})。集計結果のみ表示しています。`,
        rootCauses: [],
        studyPlan: report.weakTopics.slice(0, 3).map(t => ({ topic: t.topic, action: `${t.domain} の ${t.topic} を復習する`, priority: 'high' as const })),
      }
    }
    await saveWeaknessReport(report)
    return report
  },
})

export const weaknessWorkflow = createWorkflow({
  id: 'weakness-analysis',
  description: '複数回の受験結果から弱点を分析し、学習計画を提案する',
  inputSchema,
  outputSchema: weaknessReportSchema,
})
  .then(aggregateStep)
  .then(coachStep)
  .commit()
