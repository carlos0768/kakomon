import { randomUUID } from 'node:crypto'
import type { Mastra } from '@mastra/core'
import { z } from 'zod'
import { anthropicOptions } from '../config.ts'
import { ensureSchema, getDb, type Row } from '../db/client.ts'
import { getExam, saveExam } from '../db/repo.ts'
import { adminApprovalStep } from '../workflows/generate-exam.workflow.ts'

/**
 * 管理画面から起動する非同期ジョブ。
 * ワークフロー (ingest / analyze / generate) や正解推定 (solve) をバックグラウンドで実行し、
 * 進行状況と結果を jobs テーブルに残す。承認待ち (suspended) のジョブは resume できる。
 */

export type JobKind = 'ingest' | 'analyze' | 'generate' | 'solve'
export type JobStatus = 'running' | 'suspended' | 'success' | 'failed' | 'rejected'

export interface Job {
  id: string
  kind: JobKind
  status: JobStatus
  title: string
  runId?: string
  input: unknown
  result?: unknown
  suspend?: unknown
  error?: string
  createdAt: string
  updatedAt: string
}

const WORKFLOW_BY_KIND: Record<Exclude<JobKind, 'solve'>, 'ingestExamWorkflow' | 'analyzeExamWorkflow' | 'generateExamWorkflow'> = {
  ingest: 'ingestExamWorkflow',
  analyze: 'analyzeExamWorkflow',
  generate: 'generateExamWorkflow',
}

/** Error / {message} / 文字列 / その他 を人が読める 1 行にする */
export function errorMessage(err: unknown): string {
  if (!err) return ''
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err && 'message' in err && typeof (err as { message: unknown }).message === 'string') return (err as { message: string }).message
  try {
    return JSON.stringify(err).slice(0, 500)
  } catch {
    return String(err)
  }
}

function str(v: unknown): string | undefined {
  return v == null ? undefined : v instanceof Date ? v.toISOString() : String(v)
}

function rowToJob(r: Row): Job {
  return {
    id: String(r.id),
    kind: r.kind as JobKind,
    status: r.status as JobStatus,
    title: String(r.title),
    runId: str(r.run_id),
    input: JSON.parse(String(r.input_json)),
    result: r.result_json ? JSON.parse(String(r.result_json)) : undefined,
    suspend: r.suspend_json ? JSON.parse(String(r.suspend_json)) : undefined,
    error: str(r.error),
    createdAt: str(r.created_at)!,
    updatedAt: str(r.updated_at)!,
  }
}

async function insertJob(job: { id: string; kind: JobKind; title: string; runId?: string; input: unknown }): Promise<void> {
  await ensureSchema()
  await getDb().execute('INSERT INTO jobs (id, kind, status, title, run_id, input_json) VALUES (?, ?, ?, ?, ?, ?)', [
    job.id,
    job.kind,
    'running',
    job.title,
    job.runId ?? null,
    JSON.stringify(job.input),
  ])
}

async function updateJob(id: string, patch: { status: JobStatus; result?: unknown; suspend?: unknown; error?: string }): Promise<void> {
  await getDb().execute(
    `UPDATE jobs SET status = ?, result_json = ?, suspend_json = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [patch.status, patch.result === undefined ? null : JSON.stringify(patch.result), patch.suspend === undefined ? null : JSON.stringify(patch.suspend), patch.error ?? null, id],
  )
}

export async function getJob(id: string): Promise<Job | undefined> {
  await ensureSchema()
  const rows = await getDb().execute('SELECT * FROM jobs WHERE id = ?', [id])
  return rows[0] ? rowToJob(rows[0]) : undefined
}

export async function listJobs(limit = 50): Promise<Job[]> {
  await ensureSchema()
  const rows = await getDb().execute(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ${Math.min(limit, 200)}`)
  return rows.map(rowToJob)
}

/** ワークフローの実行結果を jobs に反映する */
async function recordWorkflowResult(jobId: string, res: { status: string; result?: unknown; steps?: Record<string, any>; error?: unknown; suspended?: unknown }) {
  if (res.status === 'success') {
    await updateJob(jobId, { status: 'success', result: res.result })
  } else if (res.status === 'suspended') {
    // 承認待ち: admin-approval ステップの suspendPayload を取り出す
    const step = res.steps?.['admin-approval']
    await updateJob(jobId, { status: 'suspended', suspend: step?.suspendPayload ?? res.suspended, result: step?.payload })
  } else {
    await updateJob(jobId, { status: 'failed', error: errorMessage((res as { error?: unknown }).error) || `workflow status: ${res.status}` })
  }
}

/** ワークフローをバックグラウンドで開始し、ジョブ ID を返す */
export async function startWorkflowJob(mastra: Mastra, kind: Exclude<JobKind, 'solve'>, title: string, input: unknown): Promise<Job> {
  const workflow = mastra.getWorkflow(WORKFLOW_BY_KIND[kind])
  const run = await workflow.createRun()
  const id = randomUUID()
  await insertJob({ id, kind, title, runId: run.runId, input })
  void run
    .start({ inputData: input as never })
    .then(res => recordWorkflowResult(id, res as never))
    .catch(err => updateJob(id, { status: 'failed', error: errorMessage(err) }))
  return (await getJob(id))!
}

/** 承認待ちの generate ジョブを再開する (approved=false なら破棄) */
export async function resumeGenerateJob(mastra: Mastra, jobId: string, resumeData: { approved: boolean; note?: string }): Promise<Job> {
  const job = await getJob(jobId)
  if (!job) throw new Error(`job not found: ${jobId}`)
  if (job.kind !== 'generate' || job.status !== 'suspended' || !job.runId) throw new Error('このジョブは承認待ちではありません')
  await updateJob(jobId, { status: 'running', result: job.result, suspend: job.suspend })
  const run = await mastra.getWorkflow('generateExamWorkflow').createRun({ runId: job.runId })
  void run
    .resume({ step: adminApprovalStep, resumeData })
    .then(async res => {
      if (res.status === 'success' && !resumeData.approved) await updateJob(jobId, { status: 'rejected', result: res.result })
      else await recordWorkflowResult(jobId, res as never)
    })
    .catch(err => updateJob(jobId, { status: 'failed', error: errorMessage(err) }))
  return (await getJob(jobId))!
}

const solveSchema = z.object({
  answers: z.array(
    z.object({
      number: z.number().int(),
      correctLabel: z.string(),
      confidence: z.number().min(0).max(1),
      rationales: z.array(z.object({ label: z.string(), rationale: z.string() })),
    }),
  ),
})

/** 正解が無い過去問に AI 推定の正解と根拠を付ける (CLI の solve と同じ処理) */
export async function solveExam(mastra: Mastra, examId: string) {
  const rec = await getExam(examId)
  if (!rec) throw new Error(`exam not found: ${examId}`)
  const targets = rec.exam.questions.filter(q => !q.correctLabel || q.choices.some(c => !c.rationale))
  if (!targets.length) return { examId, solved: [], message: 'すべての設問に正解と根拠が付いています' }
  const agent = mastra.getAgentById('exam-reviewer')
  const res = await agent.generate(
    `次の過去問設問について、正解の選択肢と、各選択肢が正解/不正解である根拠を示してください。確信が持てない場合は confidence を下げてください。\n\n${JSON.stringify(
      targets.map(q => ({ number: q.number, passage: q.passage, stem: q.stem, choices: q.choices.map(c => ({ label: c.label, text: c.text })) })),
    )}`,
    { structuredOutput: { schema: solveSchema, jsonPromptInjection: 'auto' }, modelSettings: { maxOutputTokens: 32000 }, providerOptions: anthropicOptions('high') },
  )
  const parsed = solveSchema.parse(res.object)
  for (const a of parsed.answers) {
    const q = rec.exam.questions.find(q => q.number === a.number)
    if (!q) continue
    if (!q.correctLabel) {
      q.correctLabel = a.correctLabel
      q.explanation = `${q.explanation ? q.explanation + '\n' : ''}[AI推定 confidence=${a.confidence}]`
    }
    for (const r of a.rationales) {
      const c = q.choices.find(c => c.label === r.label)
      if (c && !c.rationale) c.rationale = r.rationale
    }
  }
  await saveExam({ id: rec.id, kind: rec.kind, exam: rec.exam, status: rec.status, sourceFile: rec.sourceFile, specId: rec.specId })
  return { examId: rec.id, solved: parsed.answers.map(a => ({ number: a.number, correctLabel: a.correctLabel, confidence: a.confidence })) }
}

export async function startSolveJob(mastra: Mastra, examId: string, title: string): Promise<Job> {
  const id = randomUUID()
  await insertJob({ id, kind: 'solve', title, input: { examId } })
  void solveExam(mastra, examId)
    .then(result => updateJob(id, { status: 'success', result }))
    .catch(err => updateJob(id, { status: 'failed', error: errorMessage(err) }))
  return (await getJob(id))!
}
