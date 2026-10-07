import { describe, expect, it } from 'vitest'
import type { AttemptRecord, ExamRecord } from '../src/mastra/db/repo.ts'
import { gradeDeterministic } from '../src/mastra/services/grading.ts'
import { computeWeakness } from '../src/mastra/services/weakness.ts'
import { makeExam, makeSpec } from './fixtures.ts'

function examRecord(id: string): ExamRecord {
  const exam = makeExam()
  return { id, kind: 'predicted', title: exam.title, status: 'published', exam, specId: 's1', createdAt: '', updatedAt: '' }
}

function attempt(id: string, examId: string, exam: ExamRecord, labels: (string | null)[]): AttemptRecord {
  const answers = labels.map((l, i) => ({ questionNumber: i + 1, selectedLabel: l }))
  return {
    id,
    userId: 'u1',
    examId,
    status: 'submitted',
    answers,
    result: gradeDeterministic({ attemptId: id, examId, questions: exam.exam.questions, answers }),
    startedAt: '2026-01-01T00:00:00Z',
    submittedAt: `2026-01-0${id.slice(-1)}T00:00:00Z`,
  }
}

describe('computeWeakness', () => {
  it('requires at least two submitted attempts', () => {
    const e = examRecord('e1')
    expect(() => computeWeakness({ userId: 'u1', attempts: [attempt('a1', 'e1', e, ['1', '3', '2'])], exams: new Map([['e1', e]]) })).toThrow(/2 回以上/)
  })

  it('aggregates by topic and prioritises weighted weak topics', () => {
    const e1 = examRecord('e1')
    const e2 = examRecord('e2')
    const attempts = [
      attempt('a1', 'e1', e1, ['1', '1', '2']), // 計算 wrong
      attempt('a2', 'e2', e2, ['1', '2', '2']), // 計算 wrong again
    ]
    const report = computeWeakness({ userId: 'u1', attempts, exams: new Map([['e1', e1], ['e2', e2]]), spec: makeSpec() })
    expect(report.attemptCount).toBe(2)
    expect(report.overallAccuracy).toBeCloseTo(4 / 6, 3)
    expect(report.history.map(h => h.percentage)).toEqual([66.7, 66.7])
    const calc = report.topics.find(t => t.topic === '計算')!
    expect(calc.accuracy).toBe(0)
    expect(calc.examWeight).toBeCloseTo(0.3, 5)
    expect(report.weakTopics[0]!.topic).toBe('計算')
    expect(report.strongTopics.map(t => t.topic).sort()).toEqual(['安全管理', '構造'])
    expect(report.byQuestionType[0]).toMatchObject({ questionType: '計算', accuracy: 0 })
  })
})
