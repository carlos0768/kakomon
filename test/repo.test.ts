import { beforeEach, describe, expect, it } from 'vitest'
import { resetDbForTests } from '../src/mastra/db/client.ts'
import { aggregateQuestions, createAttempt, getExam, listAttempts, listExams, renameExam, saveExam, saveSpec, searchQuestions, submitAttempt, updateExamStatus } from '../src/mastra/db/repo.ts'
import { gradeDeterministic } from '../src/mastra/services/grading.ts'
import { makeExam, makeSpec } from './fixtures.ts'

describe('repo', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('saves and reloads exams with their questions', async () => {
    const rec = await saveExam({ kind: 'past', exam: makeExam(), sourceFile: '/tmp/x.pdf' })
    const loaded = await getExam(rec.id)
    expect(loaded?.exam.questions).toHaveLength(3)
    expect(loaded?.sourceFile).toBe('/tmp/x.pdf')
    expect(await listExams({ kind: 'past' })).toHaveLength(1)
    await updateExamStatus(rec.id, 'archived')
    expect((await getExam(rec.id))?.status).toBe('archived')
  })

  it('upserts on the same id and replaces questions', async () => {
    const rec = await saveExam({ kind: 'past', exam: makeExam() })
    const exam = makeExam({ questions: makeExam().questions.slice(0, 1) })
    await saveExam({ id: rec.id, kind: 'past', exam })
    expect((await getExam(rec.id))?.exam.questions).toHaveLength(1)
    expect(await searchQuestions({ examIds: [rec.id] })).toHaveLength(1)
  })

  it('searches questions by keyword, domain and type', async () => {
    const exam = makeExam()
    exam.questions[1]!.stem = '圧力容器の耐圧試験について正しいものはどれか'
    const rec = await saveExam({ kind: 'past', exam })
    expect(await searchQuestions({ keyword: '圧力容器 耐圧' })).toHaveLength(1)
    expect(await searchQuestions({ keyword: '圧力容器 存在しない' })).toHaveLength(0)
    expect(await searchQuestions({ domain: '技術' })).toHaveLength(2)
    expect(await searchQuestions({ questionType: '計算', kind: 'past' })).toHaveLength(1)
    expect(await searchQuestions({ keyword: '存在しない' })).toHaveLength(0)
    const agg = await aggregateQuestions([rec.id])
    expect(agg.reduce((s, r) => s + r.count, 0)).toBe(3)
  })

  it('stores specs and attempts', async () => {
    const spec = await saveSpec({ spec: makeSpec() })
    expect(spec.status).toBe('draft')
    const exam = await saveExam({ kind: 'predicted', exam: makeExam(), status: 'published', specId: spec.id })
    const attempt = await createAttempt({ userId: 'u1', examId: exam.id })
    const answers = [{ questionNumber: 1, selectedLabel: '1' }]
    const result = gradeDeterministic({ attemptId: attempt.id, examId: exam.id, questions: exam.exam.questions, answers })
    await submitAttempt(attempt.id, answers, result)
    const list = await listAttempts('u1', 'submitted')
    expect(list).toHaveLength(1)
    expect(list[0]?.result?.score).toBe(1)
  })

  it('renames an exam in both the list column and the stored exam data', async () => {
    const rec = await saveExam({ kind: 'past', exam: makeExam(), status: 'published' })
    const renamed = await renameExam(rec.id, '○○試験 (改称)')
    expect(renamed?.title).toBe('○○試験 (改称)')
    const got = await getExam(rec.id)
    expect(got?.title).toBe('○○試験 (改称)')
    expect(got?.exam.title).toBe('○○試験 (改称)')
    expect(got?.exam.questions).toHaveLength(3)
    expect(await renameExam('missing', 'x')).toBeUndefined()
  })
})
