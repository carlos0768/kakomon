import { beforeEach, describe, expect, it } from 'vitest'
import { ensureSchema, getDb, resetDbForTests } from '../src/mastra/db/client.ts'
import { failStaleJobs, getJob, parseDbTime } from '../src/mastra/services/jobs.ts'

describe('failStaleJobs', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('parses both Postgres and libSQL timestamps as UTC', () => {
    expect(parseDbTime('2026-10-08 15:12:01.54+00')).toBe(Date.parse('2026-10-08T15:12:01.54Z'))
    expect(parseDbTime('2026-10-08 15:12:01')).toBe(Date.parse('2026-10-08T15:12:01Z'))
    expect(parseDbTime(undefined)).toBeNaN()
  })

  it('marks running jobs without a recent heartbeat as failed and leaves fresh ones alone', async () => {
    await ensureSchema()
    await getDb().execute(`INSERT INTO jobs (id, kind, status, title, input_json, updated_at) VALUES ('old', 'generate', 'running', 'old', '{}', '2026-01-01 00:00:00')`)
    await getDb().execute(`INSERT INTO jobs (id, kind, status, title, input_json) VALUES ('fresh', 'generate', 'running', 'fresh', '{}')`)
    expect(await failStaleJobs()).toBe(1)
    expect((await getJob('old'))?.status).toBe('failed')
    expect((await getJob('old'))?.error).toContain('進捗の更新が無いため中断扱い')
    expect((await getJob('fresh'))?.status).toBe('running')
  })
})
