import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { RequestContext } from '@mastra/core/request-context'
import { createMockModel } from '@mastra/core/test-utils/llm-mock'
import { LibSQLStore } from '@mastra/libsql'
import { beforeEach, describe, expect, it } from 'vitest'
import { ensureSchema, getDb, resetDbForTests } from '../src/mastra/db/client.ts'
import { getExam } from '../src/mastra/db/repo.ts'
import { JOB_ID_KEY } from '../src/mastra/services/job-progress.ts'
import { getJob } from '../src/mastra/services/jobs.ts'
import { ingestExamWorkflow } from '../src/mastra/workflows/ingest-exam.workflow.ts'
import { makeExam } from './fixtures.ts'

/**
 * 取り込みワークフローの結合テスト。LLM はモックに差し替え、
 * 「stream で受ける → passages/passageId の検証 → 保存 → ジョブ進捗の書き込み」の配線を確認する。
 */
describe('ingestExamWorkflow', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('streams the extraction, keeps shared passages once and reports progress to the job row', async () => {
    const extracted = makeExam({ passages: [{ id: 'P1', text: '共有の長文' }] })
    extracted.questions[0]!.passageId = 'P1'
    extracted.questions[1]!.passageId = 'P1'
    extracted.questions[2]!.passageId = 'MISSING' // passages に無い参照は外して注意に残る

    const dir = await mkdtemp(path.join(tmpdir(), 'kakomon-ingest-'))
    const pdfPath = path.join(dir, 'exam.pdf')
    await writeFile(pdfPath, '%PDF-1.4 dummy')

    const mastra = new Mastra({
      agents: { extractor: new Agent({ id: 'exam-extractor', name: 'mock extractor', instructions: 'mock', model: createMockModel({ version: 'v2', objectGenerationMode: 'json', mockText: extracted }) }) },
      workflows: { ingestExamWorkflow },
      storage: new LibSQLStore({ id: 'test', url: ':memory:' }),
      logger: false,
    })

    await ensureSchema()
    await getDb().execute(`INSERT INTO jobs (id, kind, status, title, input_json) VALUES ('job1', 'ingest', 'running', 't', '{}')`)
    const requestContext = new RequestContext()
    requestContext.set(JOB_ID_KEY as never, 'job1' as never)

    const run = await mastra.getWorkflow('ingestExamWorkflow').createRun()
    const res = await run.start({ inputData: { filePath: pdfPath, kind: 'past', title: '上書きタイトル', year: 2025 }, requestContext })
    expect(res.status).toBe('success')
    if (res.status !== 'success') return
    expect(res.result.questionCount).toBe(3)
    expect(res.result.extractionNotes).toContain('問3: 資料文 MISSING が見つからない')

    const rec = await getExam(res.result.examId)
    expect(rec?.title).toBe('上書きタイトル')
    expect(rec?.exam.passages).toEqual([{ id: 'P1', text: '共有の長文' }])
    expect(rec?.exam.questions.map(q => q.passageId)).toEqual(['P1', 'P1', undefined])
    // 共有資料文は設問の JSON には複製されない
    expect(JSON.stringify(rec?.exam.questions)).not.toContain('共有の長文')

    const job = await getJob('job1')
    expect(job?.progress?.phase).toBe('設問を保存中')
    expect(job?.progress?.at).toBeTruthy()
  })
})
