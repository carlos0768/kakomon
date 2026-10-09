import { describe, expect, it } from 'vitest'
import { describeSections, observeSections, reconcileSpecSections } from '../src/mastra/services/exam-structure.ts'
import { makeExam, makeQuestion, makeSpec } from './fixtures.ts'

const sectioned = (counts: number[]) => {
  let n = 0
  return makeExam({
    sections: counts.map((_, i) => ({ number: i + 1, title: `第${i + 1}問` })),
    questions: counts.flatMap((c, i) => Array.from({ length: c }, () => makeQuestion({ number: ++n, section: i + 1 }))),
  })
}

describe('observeSections', () => {
  it('counts sub-questions per section and detects a shared passage', () => {
    const exam = sectioned([2, 1])
    exam.questions[0]!.passageId = 'P1'
    exam.questions[1]!.passageId = 'P1'
    expect(observeSections(exam)).toEqual([
      { number: 1, title: '第1問', instruction: undefined, questionCount: 2, domains: ['法規'], sharedPassage: true },
      { number: 2, title: '第2問', instruction: undefined, questionCount: 1, domains: ['法規'], sharedPassage: false },
    ])
  })

  it('returns undefined when the questions carry no section', () => {
    expect(observeSections(makeExam())).toBeUndefined()
  })
})

describe('reconcileSpecSections', () => {
  it('forces the observed shape when every year agrees, keeping the analyst wording, and fixes the total', () => {
    const spec = makeSpec()
    spec.format.sections = [{ number: 1, title: '第1問 (読解)', questionCount: 3, domains: ['技術'], sharedPassage: true }]
    const observed = sectioned([2, 4])
    const shape = observeSections(observed)!
    const notes = reconcileSpecSections(spec, [
      { examId: 'a', year: 2023, sections: shape },
      { examId: 'b', year: 2024, sections: shape },
    ])
    expect(spec.format.sections.map(s => [s.number, s.title, s.questionCount])).toEqual([[1, '第1問 (読解)', 2], [2, '第2問', 4]])
    expect(spec.format.questionCount).toBe(6)
    expect(notes).toEqual(['大問構成を過去問の実測に合わせて補正: 第1問 (読解) 3問 → 第1問 (読解) 2問 / 第2問 4問', '設問数を大問構成の合計に合わせて 3 → 6 問に補正'])
  })

  it('keeps the analyst choice when years differ, and falls back to the latest year when none was written', () => {
    const older = { examId: 'old', year: 2022, sections: observeSections(sectioned([3]))! }
    const newer = { examId: 'new', year: 2024, sections: observeSections(sectioned([1, 2]))! }

    const chosen = makeSpec()
    chosen.format.sections = observeSections(sectioned([3]))!
    reconcileSpecSections(chosen, [older, newer])
    expect(describeSections(chosen.format.sections)).toBe('第1問 3問')

    const empty = makeSpec()
    reconcileSpecSections(empty, [older, newer])
    expect(describeSections(empty.format.sections)).toBe('第1問 1問 / 第2問 2問')
  })

  it('leaves a spec without sections alone when past exams carry no section data', () => {
    const spec = makeSpec()
    expect(reconcileSpecSections(spec, [])).toEqual([])
    expect(spec.format.sections).toEqual([])
    expect(spec.format.questionCount).toBe(3)
  })
})
