import { describe, expect, it } from 'vitest'
import { gradeDeterministic, normalizeLabel } from '../src/mastra/services/grading.ts'
import { makeExam } from './fixtures.ts'

describe('gradeDeterministic', () => {
  it('scores answers against the answer key and seeds explanations from rationales', () => {
    const exam = makeExam()
    const result = gradeDeterministic({
      attemptId: 'a1',
      examId: 'e1',
      questions: exam.questions,
      answers: [
        { questionNumber: 1, selectedLabel: '1' }, // correct
        { questionNumber: 2, selectedLabel: '2' }, // wrong (correct 3)
        { questionNumber: 3, selectedLabel: null }, // unanswered
      ],
    })
    expect(result.score).toBe(1)
    expect(result.total).toBe(3)
    expect(result.percentage).toBe(33.3)
    expect(result.feedback[0]).toMatchObject({ correct: true, whyYourChoice: '1 は正しい' })
    expect(result.feedback[1]).toMatchObject({ correct: false, correctLabel: '3', whyYourChoice: '2 は誤り: 用語の取り違え', whyCorrect: '3 は誤り: 数値が違う' })
    expect(result.feedback[2]).toMatchObject({ correct: false, selectedLabel: null, whyYourChoice: '未回答です。' })
  })

  it('tolerates full-width labels and trailing punctuation', () => {
    expect(normalizeLabel('１．')).toBe('1')
    expect(normalizeLabel('Ａ)')).toBe('a')
    expect(normalizeLabel(' ア ')).toBe('ア')
  })

  it('throws when a question has no answer key', () => {
    const exam = makeExam()
    exam.questions[0]!.correctLabel = undefined
    expect(() => gradeDeterministic({ attemptId: 'a', examId: 'e', questions: exam.questions, answers: [] })).toThrow(/no correct label/)
  })
})
