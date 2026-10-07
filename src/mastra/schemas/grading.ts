import { z } from 'zod'

/** 受験者の解答 */
export const answerSchema = z.object({
  questionNumber: z.number().int(),
  selectedLabel: z.string().nullable().describe('選択したラベル。未回答は null'),
})
export type Answer = z.infer<typeof answerSchema>

/** 1 問ごとの添削結果 */
export const questionFeedbackSchema = z.object({
  questionNumber: z.number().int(),
  correct: z.boolean(),
  selectedLabel: z.string().nullable(),
  correctLabel: z.string(),
  domain: z.string(),
  topic: z.string(),
  /** 選んだ選択肢がなぜ誤りか (正解時は正解の根拠) */
  whyYourChoice: z.string(),
  /** 正解の根拠 */
  whyCorrect: z.string(),
  /** 次に活かすためのひと言 */
  tip: z.string().optional(),
})
export type QuestionFeedback = z.infer<typeof questionFeedbackSchema>

export const gradingResultSchema = z.object({
  attemptId: z.string(),
  examId: z.string(),
  score: z.number().int(),
  total: z.number().int(),
  percentage: z.number(),
  feedback: z.array(questionFeedbackSchema),
  /** 全体講評 */
  overview: z.string(),
})
export type GradingResult = z.infer<typeof gradingResultSchema>

/** LLM が生成する解説部分だけのスキーマ (採点そのものはコードで決定的に行う) */
export const explanationBatchSchema = z.object({
  items: z.array(
    z.object({
      questionNumber: z.number().int(),
      whyYourChoice: z.string(),
      whyCorrect: z.string(),
      tip: z.string().optional(),
    }),
  ),
  overview: z.string(),
})

/** 弱点分析 */
export const topicStatSchema = z.object({
  domain: z.string(),
  topic: z.string(),
  attempted: z.number().int(),
  correct: z.number().int(),
  accuracy: z.number(),
  /** 要件定義上の出題比率 (重要度) */
  examWeight: z.number().optional(),
  /** 重要度 × 誤答率 で算出した優先度 */
  priority: z.number(),
})

export const weaknessReportSchema = z.object({
  userId: z.string(),
  attemptCount: z.number().int(),
  overallAccuracy: z.number(),
  /** 回ごとの推移 */
  history: z.array(
    z.object({ attemptId: z.string(), examId: z.string(), examTitle: z.string(), percentage: z.number(), at: z.string() }),
  ),
  topics: z.array(topicStatSchema),
  weakTopics: z.array(topicStatSchema),
  strongTopics: z.array(topicStatSchema),
  /** 問われ方の型ごとの正答率 */
  byQuestionType: z.array(z.object({ questionType: z.string(), attempted: z.number().int(), accuracy: z.number() })),
  /** LLM による講評と学習計画 */
  coaching: z
    .object({
      summary: z.string(),
      rootCauses: z.array(z.string()),
      studyPlan: z.array(z.object({ topic: z.string(), action: z.string(), priority: z.enum(['high', 'medium', 'low']) })),
    })
    .optional(),
})
export type WeaknessReport = z.infer<typeof weaknessReportSchema>
export const coachingSchema = weaknessReportSchema.shape.coaching.unwrap()
