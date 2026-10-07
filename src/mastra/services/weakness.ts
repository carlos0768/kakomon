import type { AttemptRecord, ExamRecord } from '../db/repo.ts'
import type { ExamSpec } from '../schemas/spec.ts'
import type { WeaknessReport } from '../schemas/grading.ts'

export const MIN_ATTEMPTS_FOR_WEAKNESS = 2

/**
 * 弱点分析の集計 (決定的)。
 * 2 回分以上の受験結果を分野・トピック・設問型ごとに集計し、
 * 「出題比率 × 誤答率」で優先度を付ける。
 */
export function computeWeakness(params: {
  userId: string
  attempts: AttemptRecord[]
  exams: Map<string, ExamRecord>
  spec?: ExamSpec
}): Omit<WeaknessReport, 'coaching'> {
  const attempts = params.attempts.filter(a => a.status === 'submitted' && a.result)
  if (attempts.length < MIN_ATTEMPTS_FOR_WEAKNESS) {
    throw new Error(`弱点分析には ${MIN_ATTEMPTS_FOR_WEAKNESS} 回以上の受験が必要です (現在 ${attempts.length} 回)`)
  }

  const topicMap = new Map<string, { domain: string; topic: string; attempted: number; correct: number }>()
  const typeMap = new Map<string, { attempted: number; correct: number }>()
  let attempted = 0
  let correct = 0

  for (const a of attempts) {
    const exam = params.exams.get(a.examId)
    const byNumber = new Map(exam?.exam.questions.map(q => [q.number, q]) ?? [])
    for (const f of a.result!.feedback) {
      attempted++
      if (f.correct) correct++
      const key = `${f.domain}\u0000${f.topic}`
      const t = topicMap.get(key) ?? { domain: f.domain, topic: f.topic, attempted: 0, correct: 0 }
      t.attempted++
      if (f.correct) t.correct++
      topicMap.set(key, t)
      const qt = byNumber.get(f.questionNumber)?.questionType ?? 'その他'
      const s = typeMap.get(qt) ?? { attempted: 0, correct: 0 }
      s.attempted++
      if (f.correct) s.correct++
      typeMap.set(qt, s)
    }
  }

  const weights = specTopicWeights(params.spec)
  const topics = [...topicMap.values()]
    .map(t => {
      const accuracy = t.attempted ? t.correct / t.attempted : 0
      const examWeight = weights.get(`${t.domain}\u0000${t.topic}`) ?? weights.get(t.domain)
      // 重要度 (出題比率, 不明なら均等) × 誤答率 × 試行数の信頼度補正
      const weight = examWeight ?? 1 / Math.max(topicMap.size, 1)
      const confidence = Math.min(1, t.attempted / 3)
      const priority = round(weight * (1 - accuracy) * (0.5 + 0.5 * confidence) * 100)
      return { ...t, accuracy: round(accuracy), examWeight, priority }
    })
    .sort((a, b) => b.priority - a.priority)

  return {
    userId: params.userId,
    attemptCount: attempts.length,
    overallAccuracy: round(attempted ? correct / attempted : 0),
    history: attempts.map(a => ({
      attemptId: a.id,
      examId: a.examId,
      examTitle: params.exams.get(a.examId)?.title ?? a.examId,
      percentage: a.result!.percentage,
      at: a.submittedAt ?? a.startedAt,
    })),
    topics,
    weakTopics: topics.filter(t => t.accuracy < 0.6).slice(0, 8),
    strongTopics: [...topics].filter(t => t.accuracy >= 0.8 && t.attempted >= 2).sort((a, b) => b.accuracy - a.accuracy).slice(0, 5),
    byQuestionType: [...typeMap.entries()]
      .map(([questionType, s]) => ({ questionType, attempted: s.attempted, accuracy: round(s.correct / s.attempted) }))
      .sort((a, b) => a.accuracy - b.accuracy),
  }
}

/** 要件定義から「分野\0トピック」→ 試験全体での出題比率 を作る (分野単独キーも入れる) */
function specTopicWeights(spec?: ExamSpec): Map<string, number> {
  const m = new Map<string, number>()
  if (!spec) return m
  for (const d of spec.domains) {
    m.set(d.domain, d.share)
    for (const t of d.topics) m.set(`${d.domain}\u0000${t.topic}`, d.share * t.share)
  }
  return m
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
