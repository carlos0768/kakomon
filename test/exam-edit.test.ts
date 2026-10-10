import { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { createMockModel } from '@mastra/core/test-utils/llm-mock'
import { LibSQLStore } from '@mastra/libsql'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDbForTests } from '../src/mastra/db/client.ts'
import { getExam, saveExam } from '../src/mastra/db/repo.ts'
import { applyExamEdit, editBlockReason, editExamWithPrompt, examEditSchema } from '../src/mastra/services/exam-edit.ts'
import { makeExam, makeQuestion } from './fixtures.ts'

const edit = (over: Partial<Parameters<typeof examEditSchema.parse>[0]> = {}) => examEditSchema.parse({ summary: 'test', ...over })

describe('applyExamEdit', () => {
  it('replaces questions by number and leaves the others untouched', () => {
    const exam = makeExam()
    const res = applyExamEdit(exam, edit({ questions: [makeQuestion({ number: 2, stem: '書き換えた問題文', correctLabel: '2' })] }))
    expect(res.exam.questions.map(q => q.stem)).toEqual([exam.questions[0]!.stem, '書き換えた問題文', exam.questions[2]!.stem])
    expect(res.changedNumbers).toEqual([2])
    expect(exam.questions[1]!.stem).toBe('設問 2 の問題文') // 元のデータは変更しない
  })

  it('removes, appends and renumbers from 1', () => {
    const res = applyExamEdit(makeExam(), edit({ removeQuestionNumbers: [1], questions: [makeQuestion({ number: 4, stem: '追加した設問' })] }))
    expect(res.exam.questions.map(q => q.number)).toEqual([1, 2, 3])
    expect(res.exam.questions.map(q => q.stem)).toEqual(['設問 2 の問題文', '設問 3 の問題文', '追加した設問'])
    expect(res.changedNumbers).toEqual([3])
    expect(res.removedCount).toBe(1)
  })

  it('updates title / instructions only when given and keeps passages consistent', () => {
    const exam = makeExam({ passages: [{ id: 'P1', text: '旧本文' }], questions: [makeQuestion({ number: 1, passageId: 'P1' }), makeQuestion({ number: 2, passageId: 'P1' })] })
    const res = applyExamEdit(exam, edit({ title: '新タイトル', removePassageIds: ['P1'], questions: [makeQuestion({ number: 2, correctLabel: '9' })] }))
    expect(res.exam.title).toBe('新タイトル')
    expect(res.exam.instructions).toEqual(exam.instructions)
    expect(res.exam.passages).toEqual([])
    expect(res.exam.questions[0]?.passageId).toBeUndefined()
    expect(res.notes).toContain('問1: 資料文 P1 が見つからないため参照を外した')
    expect(res.notes).toContain('問2: 正解ラベル 9 が選択肢にありません。確認してください')
  })

  it('ignores unknown removals and refuses to delete every question', () => {
    expect(applyExamEdit(makeExam(), edit({ removeQuestionNumbers: [99] })).notes).toContain('削除指定の問99 は存在しないため無視')
    expect(() => applyExamEdit(makeExam(), edit({ removeQuestionNumbers: [1, 2, 3] }))).toThrow(/0 問/)
  })
})

describe('editBlockReason', () => {
  it('allows only unpublished predicted exams', () => {
    expect(editBlockReason({ kind: 'predicted', status: 'review' })).toBeUndefined()
    expect(editBlockReason({ kind: 'predicted', status: 'archived' })).toBeUndefined()
    expect(editBlockReason({ kind: 'predicted', status: 'published' })).toMatch(/非公開にしてから/)
    expect(editBlockReason({ kind: 'past', status: 'published' })).toMatch(/予想問題だけ/)
    expect(editBlockReason(undefined)).toMatch(/見つかりません/)
  })
})

describe('editExamWithPrompt', () => {
  beforeEach(async () => {
    await resetDbForTests()
    process.env.KAKOMON_CHROMIUM_PATH = '/nonexistent/chromium'
  })

  function mastraWith(mockText: unknown) {
    const model = createMockModel({ version: 'v2', objectGenerationMode: 'json', mockText: mockText as never })
    return new Mastra({
      agents: { generator: new Agent({ id: 'exam-generator', name: 'mock generator', instructions: 'mock', model }) },
      storage: new LibSQLStore({ id: 'test', url: ':memory:' }),
      logger: false,
    })
  }

  it('applies the LLM patch, keeps the status and records the edit history', async () => {
    const rec = await saveExam({ kind: 'predicted', exam: makeExam(), status: 'review' })
    const mastra = mastraWith({ questions: [makeQuestion({ number: 3, stem: '直した問3' })], removeQuestionNumbers: [1], summary: '問1を削除し問3を修正' })
    const res = await editExamWithPrompt(mastra, rec.id, '問1を消して問3を直して')
    expect(res).toMatchObject({ questionCount: 2, changedNumbers: [2], removedCount: 1, summary: '問1を削除し問3を修正' })
    const saved = await getExam(rec.id)
    expect(saved?.status).toBe('review')
    expect(saved?.exam.questions.map(q => q.stem)).toEqual(['設問 2 の問題文', '直した問3'])
    expect(saved?.exam.extractionNotes.some(n => n.includes('指示: 問1を消して問3を直して') && n.includes('問1を削除し問3を修正'))).toBe(true)
  })

  it('refuses to edit a published exam', async () => {
    const rec = await saveExam({ kind: 'predicted', exam: makeExam(), status: 'published' })
    await expect(editExamWithPrompt(mastraWith({ summary: 'x' }), rec.id, '直して')).rejects.toThrow(/非公開にしてから/)
  })
})
