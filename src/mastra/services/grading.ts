import type { Answer, GradingResult, QuestionFeedback } from '../schemas/grading.ts'
import type { Question } from '../schemas/exam.ts'

/**
 * 決定的な採点。正誤は正解ラベルと照合して機械的に決め、
 * 解説文 (whyYourChoice / whyCorrect) の初期値は選択肢の rationale から組み立てる。
 * LLM による添削はこの結果を土台に文章を仕上げる。
 */
export function gradeDeterministic(params: {
  attemptId: string
  examId: string
  questions: Question[]
  answers: Answer[]
}): GradingResult {
  const byNumber = new Map(params.answers.map(a => [a.questionNumber, a.selectedLabel]))
  const feedback: QuestionFeedback[] = []
  let score = 0
  for (const q of params.questions) {
    const correctLabel = q.correctLabel
    if (!correctLabel) throw new Error(`question ${q.number} has no correct label`)
    const selected = byNumber.get(q.number) ?? null
    const correct = selected != null && normalizeLabel(selected) === normalizeLabel(correctLabel)
    if (correct) score++
    const chosen = selected != null ? q.choices.find(c => normalizeLabel(c.label) === normalizeLabel(selected)) : undefined
    const correctChoice = q.choices.find(c => normalizeLabel(c.label) === normalizeLabel(correctLabel))
    feedback.push({
      questionNumber: q.number,
      correct,
      selectedLabel: selected,
      correctLabel,
      domain: q.domain,
      topic: q.topic,
      whyYourChoice:
        selected == null
          ? '未回答です。'
          : (chosen?.rationale ?? (correct ? '正解です。' : `選択肢 ${selected} は誤りです。`)),
      whyCorrect: correctChoice?.rationale ?? q.explanation ?? `正解は ${correctLabel} です。`,
    })
  }
  const total = params.questions.length
  return {
    attemptId: params.attemptId,
    examId: params.examId,
    score,
    total,
    percentage: total ? Math.round((score / total) * 1000) / 10 : 0,
    feedback,
    overview: '',
  }
}

export function normalizeLabel(label: string): string {
  return label
    .trim()
    .replace(/[．.、,)）]/g, '')
    .replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[ａ-ｚＡ-Ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
}
