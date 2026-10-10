import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { createMockModel } from '@mastra/core/test-utils/llm-mock'
import { LibSQLStore } from '@mastra/libsql'
import { beforeEach, describe, expect, it } from 'vitest'
import { ensureSchema, getDb, resetDbForTests } from '../src/mastra/db/client.ts'
import { getExam, saveExam } from '../src/mastra/db/repo.ts'
import { abortJob, JobCancelledError, registerJobAbort, releaseJobAbort } from '../src/mastra/services/job-progress.ts'
import { cancelJob, getJob, importAnswerKey, JobStateError, resumeGenerateJob, withStartLock } from '../src/mastra/services/jobs.ts'
import { generateExamWorkflow } from '../src/mastra/workflows/generate-exam.workflow.ts'
import { makeExam } from './fixtures.ts'

/** 停止ボタン・連打防止・正解データのインポートの配線を確認する */

async function insertJob(id: string, kind: string, status: string, runId: string | null = null) {
  await ensureSchema()
  await getDb().execute(`INSERT INTO jobs (id, kind, status, title, run_id, input_json) VALUES (?, ?, ?, ?, ?, '{}')`, [id, kind, status, id, runId])
}

function mastraWithExtractor(answerKey: Record<string, unknown>) {
  const model = createMockModel({ version: 'v2', objectGenerationMode: 'json', mockText: answerKey })
  return new Mastra({
    agents: { extractor: new Agent({ id: 'exam-extractor', name: 'mock extractor', instructions: 'mock', model }) },
    workflows: { generateExamWorkflow },
    storage: new LibSQLStore({ id: 'test', url: ':memory:' }),
    logger: false,
  })
}

async function dummyPdf(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kakomon-test-'))
  const file = path.join(dir, 'answers.pdf')
  await writeFile(file, '%PDF-1.4 dummy')
  return file
}

describe('cancelJob', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('marks a running job as cancelled and refuses jobs that are not running', async () => {
    await insertJob('run1', 'ingest', 'running')
    await insertJob('done1', 'ingest', 'success')
    const job = await cancelJob('run1')
    expect(job.status).toBe('cancelled')
    expect(job.error).toBe('管理者が停止しました')
    await expect(cancelJob('run1')).rejects.toMatchObject({ status: 409 })
    await expect(cancelJob('done1')).rejects.toBeInstanceOf(JobStateError)
    await expect(cancelJob('missing')).rejects.toMatchObject({ status: 404 })
  })
})

describe('withStartLock', () => {
  it('rejects a second start with the same key while the first is still starting', async () => {
    let release!: () => void
    const first = withStartLock(['k'], () => new Promise<string>(r => (release = () => r('first'))))
    expect(await withStartLock(['k', 'other'], async () => 'second')).toBeUndefined()
    release()
    expect(await first).toBe('first')
    // 1 つ目が終われば同じキーでまた始められる
    expect(await withStartLock(['k'], async () => 'third')).toBe('third')
  })
})

describe('resumeGenerateJob', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('accepts only one of two simultaneous approve clicks', async () => {
    await insertJob('gen1', 'generate', 'suspended', 'run-x')
    const mastra = mastraWithExtractor({})
    const results = await Promise.allSettled([
      resumeGenerateJob(mastra, 'gen1', { approved: false }),
      resumeGenerateJob(mastra, 'gen1', { approved: false }),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ status: 409 })
  })
})

describe('importAnswerKey', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('overwrites answers from the answer-key PDF and reports mismatches', async () => {
    const rec = await saveExam({ kind: 'past', exam: makeExam(), status: 'published' })
    const mastra = mastraWithExtractor({
      answers: [
        { number: 1, correctLabel: '２', explanation: '公式解説 1', rationales: [{ label: '1', rationale: '1 は誤り (公式)' }] },
        { number: 2, correctLabel: '9' },
        { number: 99, correctLabel: '1' },
      ],
      notes: [],
    })
    const res = await importAnswerKey(mastra, rec.id, await dummyPdf())
    expect(res.applied).toBe(1)
    expect(res.changed).toEqual([{ number: 1, from: '1', to: '2' }])
    expect(res.missing).toEqual([3])
    expect(res.notes.join('\n')).toContain('問2: 正解「9」が選択肢')
    expect(res.notes.join('\n')).toContain('問99')
    const saved = await getExam(rec.id)
    const q1 = saved!.exam.questions.find(q => q.number === 1)!
    expect(q1.correctLabel).toBe('2')
    expect(q1.explanation).toBe('公式解説 1')
    expect(q1.choices.find(c => c.label === '1')?.rationale).toBe('1 は誤り (公式)')
    expect(saved!.exam.questions.find(q => q.number === 2)!.correctLabel).toBe('3')
  })

  it('stops without saving when the job has been cancelled', async () => {
    const rec = await saveExam({ kind: 'past', exam: makeExam(), status: 'published' })
    const mastra = mastraWithExtractor({ answers: [{ number: 1, correctLabel: '4' }], notes: [] })
    await insertJob('ans1', 'answers', 'running')
    registerJobAbort('ans1')
    abortJob('ans1')
    try {
      await expect(importAnswerKey(mastra, rec.id, await dummyPdf(), 'ans1')).rejects.toBeInstanceOf(JobCancelledError)
    } finally {
      releaseJobAbort('ans1')
    }
    expect((await getExam(rec.id))!.exam.questions.find(q => q.number === 1)!.correctLabel).toBe('1')
    expect((await getJob('ans1'))?.status).toBe('running') // 記録の更新は cancelJob / ジョブ側の担当
  })
})
