import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { resetDbForTests } from '../src/mastra/db/client.ts'
import { aggregateQuestions, createAttempt, getExam, listAttempts, listExams, saveExam, saveSpec, searchQuestions, submitAttempt, updateExamStatus } from '../src/mastra/db/repo.ts'
import { gradeDeterministic } from '../src/mastra/services/grading.ts'
import { makeExam, makeSpec } from './fixtures.ts'

/**
 * Postgres (Supabase 想定) 方言での結合テスト。
 * KAKOMON_TEST_PG_URL (例: postgresql://postgres@127.0.0.1:54329/kakomon_test) があるときだけ実行する。
 */
const PG_URL = process.env.KAKOMON_TEST_PG_URL

describe.skipIf(!PG_URL)('repo (postgres)', () => {
  beforeEach(async () => {
    await resetDbForTests(PG_URL)
  })
  afterAll(async () => {
    await resetDbForTests()
  })

  it('round-trips exams, questions, specs and attempts', async () => {
    const spec = await saveSpec({ spec: makeSpec() })
    const exam = makeExam()
    exam.questions[1]!.stem = '圧力容器の耐圧試験について正しいものはどれか'
    const rec = await saveExam({ kind: 'predicted', exam, status: 'published', specId: spec.id, sourceFile: '/x.pdf' })
    const loaded = await getExam(rec.id)
    expect(loaded?.exam.questions).toHaveLength(3)
    expect(loaded?.specId).toBe(spec.id)
    expect(loaded?.createdAt).toBeTruthy()

    // upsert
    await saveExam({ id: rec.id, kind: 'predicted', exam: makeExam({ questions: exam.questions.slice(0, 2) }), status: 'published' })
    expect((await getExam(rec.id))?.exam.questions).toHaveLength(2)
    expect(await listExams({ kind: 'predicted', status: 'published' })).toHaveLength(1)

    expect(await searchQuestions({ keyword: '圧力容器 耐圧' })).toHaveLength(1)
    expect(await searchQuestions({ domain: '技術', kind: 'predicted' })).toHaveLength(1)
    const agg = await aggregateQuestions([rec.id])
    expect(agg.reduce((s, r) => s + r.count, 0)).toBe(2)

    const attempt = await createAttempt({ userId: 'u1', examId: rec.id })
    const answers = [{ questionNumber: 1, selectedLabel: '1' }, { questionNumber: 2, selectedLabel: '2' }]
    const result = gradeDeterministic({ attemptId: attempt.id, examId: rec.id, questions: (await getExam(rec.id))!.exam.questions, answers })
    await submitAttempt(attempt.id, answers, result)
    const list = await listAttempts('u1', 'submitted')
    expect(list[0]?.result?.score).toBe(1)
    expect(list[0]?.submittedAt).toBeTruthy()

    await updateExamStatus(rec.id, 'archived')
    expect((await getExam(rec.id))?.status).toBe('archived')
  })
})
