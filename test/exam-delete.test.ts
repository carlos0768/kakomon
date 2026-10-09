import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { config } from '../src/mastra/config.ts'
import { getDb, resetDbForTests } from '../src/mastra/db/client.ts'
import { getExam, getSpec, saveExam, saveSpec, searchQuestions } from '../src/mastra/db/repo.ts'
import { deleteBlockReason, deletePastExam } from '../src/mastra/services/exam-delete.ts'
import { makeExam, makeSpec } from './fixtures.ts'

const runningJob = (id: string, kind: string, input: unknown) =>
  getDb().execute(`INSERT INTO jobs (id, kind, status, title, input_json) VALUES (?, ?, 'running', ?, ?)`, [id, kind, id, JSON.stringify(input)])

describe('deletePastExam', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('removes the exam and its questions, keeps specs built from it and reports them', async () => {
    const past = await saveExam({ kind: 'past', exam: makeExam(), status: 'published' })
    const other = await saveExam({ kind: 'past', exam: makeExam({ title: '別の試験' }), status: 'published' })
    const spec = await saveSpec({ spec: makeSpec({ sourceExamIds: [past.id, other.id] }) })

    const res = await deletePastExam(past.id)
    expect(res).toEqual({ examId: past.id, title: 'サンプル試験', specIds: [spec.id], notes: [] })
    expect(await getExam(past.id)).toBeUndefined()
    expect((await searchQuestions({})).every(h => h.examId === other.id)).toBe(true)
    expect(await getSpec(spec.id)).toBeDefined()
    expect(await deletePastExam(past.id)).toBeUndefined()
  })

  it('refuses to delete a predicted exam', async () => {
    const predicted = await saveExam({ kind: 'predicted', exam: makeExam(), status: 'published' })
    await expect(deletePastExam(predicted.id)).rejects.toThrow('削除できるのは過去問だけ')
    expect(await getExam(predicted.id)).toBeDefined()
  })

  it('deletes the uploaded copy of the PDF but never a PDF the admin placed there by hand', async () => {
    await mkdir(config.uploadDir, { recursive: true })
    const uploaded = path.join(config.uploadDir, '1760000000000-abcdef12-test-delete.pdf')
    const handPlaced = path.join(config.uploadDir, 'test-delete-original.pdf')
    await writeFile(uploaded, 'pdf')
    await writeFile(handPlaced, 'pdf')
    try {
      const a = await saveExam({ kind: 'past', exam: makeExam(), status: 'published', sourceFile: uploaded })
      const b = await saveExam({ kind: 'past', exam: makeExam(), status: 'published', sourceFile: handPlaced })
      await deletePastExam(a.id)
      await deletePastExam(b.id)
      expect(existsSync(uploaded)).toBe(false)
      expect(existsSync(handPlaced)).toBe(true)
    } finally {
      await rm(uploaded, { force: true })
      await rm(handPlaced, { force: true })
    }
  })
})

describe('deleteBlockReason', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('blocks while a job reads or writes the exam, and allows it otherwise', async () => {
    const past = await saveExam({ kind: 'past', exam: makeExam(), status: 'published' })
    const other = await saveExam({ kind: 'past', exam: makeExam(), status: 'published' })
    const spec = await saveSpec({ spec: makeSpec({ sourceExamIds: [other.id] }) })
    await getExam(past.id) // スキーマ作成済みにする

    await runningJob('g', 'generate', { specId: spec.id, title: 't' })
    await runningJob('a', 'analyze', { examIds: [other.id] })
    expect(await deleteBlockReason(past.id)).toBeUndefined() // 別の過去問だけを使うジョブは関係ない

    await runningJob('s', 'solve', { examId: past.id })
    expect(await deleteBlockReason(past.id)).toContain('正解推定・正解インポートが実行中')
    await getDb().execute(`DELETE FROM jobs WHERE id = 's'`)

    await runningJob('a2', 'analyze', {}) // 対象未指定 = すべての過去問
    expect(await deleteBlockReason(past.id)).toContain('傾向分析が実行中')
    await getDb().execute(`DELETE FROM jobs WHERE id = 'a2'`)

    await runningJob('g2', 'generate', { specId: spec.id, title: 't2', referenceExamId: past.id }) // 関係ない作問 g と同時に動いていても検出する
    expect(await deleteBlockReason(past.id)).toContain('作問が実行中')
  })
})
