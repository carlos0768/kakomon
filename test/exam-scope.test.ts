import { RequestContext } from '@mastra/core/request-context'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDbForTests } from '../src/mastra/db/client.ts'
import { saveExam } from '../src/mastra/db/repo.ts'
import { examScopeFrom, restrictToScope, setExamScope } from '../src/mastra/services/exam-scope.ts'
import { getPastExamTool, getQuestionStatsTool, listPastExamsTool, searchPastQuestionsTool } from '../src/mastra/tools/past-exam-tools.ts'
import { makeExam } from './fixtures.ts'

/**
 * 傾向分析で対象の過去問を選んだとき、ツール経由で対象外の過去問が混ざらないことを確認する。
 */
describe('exam scope', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('restrictToScope keeps requested ids inside the scope and falls back to the whole scope', () => {
    expect(restrictToScope(undefined, undefined)).toBeUndefined()
    expect(restrictToScope(undefined, ['a'])).toEqual(['a'])
    expect(restrictToScope(['a', 'b'], undefined)).toEqual(['a', 'b'])
    expect(restrictToScope(['a', 'b'], ['b', 'zzz'])).toEqual(['b'])
    const rc = new RequestContext()
    expect(examScopeFrom(rc)).toBeUndefined()
    setExamScope(rc, ['a'])
    expect(examScopeFrom(rc)).toEqual(['a'])
  })

  it('past-exam tools only see exams inside the scope', async () => {
    const a = await saveExam({ kind: 'past', exam: makeExam({ title: '試験A', year: 2025 }) })
    const b = await saveExam({ kind: 'past', exam: makeExam({ title: '試験B', year: 2024 }) })
    const requestContext = new RequestContext()
    setExamScope(requestContext, [a.id])
    const ctx = { requestContext } as never

    const listed = await listPastExamsTool.execute!({ kind: 'past' }, ctx)
    expect((listed as { exams: { examId: string }[] }).exams.map(e => e.examId)).toEqual([a.id])

    const stats = await getQuestionStatsTool.execute!({}, ctx)
    expect(new Set((stats as { rows: { examId: string }[] }).rows.map(r => r.examId))).toEqual(new Set([a.id]))
    // 範囲外だけを指定したら空
    expect((await getQuestionStatsTool.execute!({ examIds: [b.id] }, ctx)) as object).toEqual({ rows: [] })

    const hits = await searchPastQuestionsTool.execute!({ limit: 50 }, ctx)
    expect(new Set((hits as { hits: { examId: string }[] }).hits.map(h => h.examId))).toEqual(new Set([a.id]))

    await expect(getPastExamTool.execute!({ examId: b.id }, ctx)).rejects.toThrow(/outside the analysis scope/)
    expect(((await getPastExamTool.execute!({ examId: a.id }, ctx)) as { examId: string }).examId).toBe(a.id)

    // 範囲が無ければ従来どおり全件
    const all = await listPastExamsTool.execute!({ kind: 'past' }, { requestContext: new RequestContext() } as never)
    expect((all as { exams: unknown[] }).exams).toHaveLength(2)
  })
})
