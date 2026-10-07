import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { anthropicOptions } from '../config.ts'
import { getAttempt, getExam, submitAttempt } from '../db/repo.ts'
import { answerSchema, explanationBatchSchema, gradingResultSchema } from '../schemas/grading.ts'
import { gradeDeterministic } from '../services/grading.ts'

/**
 * 添削: コードで正誤判定 → LLM が「選んだ選択肢がなぜ誤りか」を解説 → 保存。
 */

const inputSchema = z.object({
  attemptId: z.string(),
  answers: z.array(answerSchema),
})

const gradeStep = createStep({
  id: 'grade-deterministic',
  inputSchema,
  outputSchema: z.object({ input: inputSchema, result: gradingResultSchema, examTitle: z.string() }),
  execute: async ({ inputData }) => {
    const attempt = await getAttempt(inputData.attemptId)
    if (!attempt) throw new Error(`attempt not found: ${inputData.attemptId}`)
    if (attempt.status === 'submitted') throw new Error('この受験はすでに採点済みです')
    const exam = await getExam(attempt.examId)
    if (!exam) throw new Error(`exam not found: ${attempt.examId}`)
    const result = gradeDeterministic({
      attemptId: attempt.id,
      examId: exam.id,
      questions: exam.exam.questions,
      answers: inputData.answers,
    })
    return { input: inputData, result, examTitle: exam.title }
  },
})

const explainStep = createStep({
  id: 'explain-with-llm',
  inputSchema: gradeStep.outputSchema,
  outputSchema: gradingResultSchema,
  execute: async ({ inputData, mastra }) => {
    const { result } = inputData
    const exam = await getExam(result.examId)
    const byNumber = new Map(exam?.exam.questions.map(q => [q.number, q]) ?? [])
    const agent = mastra.getAgentById('exam-grader')

    const items = result.feedback.map(f => {
      const q = byNumber.get(f.questionNumber)!
      return {
        questionNumber: f.questionNumber,
        correct: f.correct,
        stem: q.stem,
        passage: q.passage,
        choices: q.choices.map(c => ({ label: c.label, text: c.text, rationale: c.rationale })),
        selectedLabel: f.selectedLabel,
        correctLabel: f.correctLabel,
        domain: f.domain,
        topic: f.topic,
        questionType: q.questionType,
      }
    })

    try {
      const res = await agent.generate(
        `試験「${inputData.examTitle}」の採点結果です。得点 ${result.score}/${result.total} (${result.percentage}%)。
各設問について whyYourChoice / whyCorrect / tip を書き、最後に overview を書いてください。

設問と解答 (JSON):
${JSON.stringify(items)}`,
        {
          structuredOutput: { schema: explanationBatchSchema, jsonPromptInjection: 'auto' },
          modelSettings: { maxOutputTokens: 32000 },
          providerOptions: anthropicOptions('medium'),
        },
      )
      const batch = explanationBatchSchema.parse(res.object)
      const byQ = new Map(batch.items.map(i => [i.questionNumber, i]))
      for (const f of result.feedback) {
        const e = byQ.get(f.questionNumber)
        if (!e) continue
        f.whyYourChoice = e.whyYourChoice || f.whyYourChoice
        f.whyCorrect = e.whyCorrect || f.whyCorrect
        f.tip = e.tip
      }
      result.overview = batch.overview
    } catch (err) {
      // LLM 解説に失敗しても採点結果 (rationale ベースの解説) は返す
      result.overview = `自動解説の生成に失敗したため、選択肢ごとの根拠のみ表示しています (${err instanceof Error ? err.message : String(err)})`
    }
    await submitAttempt(result.attemptId, inputData.input.answers, result)
    return result
  },
})

export const gradeAttemptWorkflow = createWorkflow({
  id: 'grade-attempt',
  description: '解答を採点し、選んだ選択肢がなぜ誤りかを LLM が解説する',
  inputSchema,
  outputSchema: gradingResultSchema,
})
  .then(gradeStep)
  .then(explainStep)
  .commit()
