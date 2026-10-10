import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Mastra } from '@mastra/core'
import { RequestContext } from '@mastra/core/request-context'
import { z } from 'zod'
import { anthropicOptions, config } from '../config.ts'
import { ensureSchema, getDb, type Row } from '../db/client.ts'
import { getExam, saveExam } from '../db/repo.ts'
import { adminApprovalStep } from '../workflows/generate-exam.workflow.ts'
import { abortJob, JOB_ID_KEY, JobCancelledError, progressReporter, registerJobAbort, releaseJobAbort, type JobProgress } from './job-progress.ts'
import { editExamWithPrompt } from './exam-edit.ts'
import { streamObject } from './llm.ts'

/**
 * 管理画面から起動する非同期ジョブ。
 * ワークフロー (ingest / analyze / generate) や正解推定 (solve)、プロンプト編集 (edit) をバックグラウンドで実行し、
 * 進行状況と結果を jobs テーブルに残す。承認待ち (suspended) のジョブは resume できる。
 * 実行中のジョブは cancelJob で停止できる (status = cancelled)。
 */

export type JobKind = 'ingest' | 'analyze' | 'generate' | 'solve' | 'answers' | 'edit'
export type JobStatus = 'running' | 'suspended' | 'success' | 'failed' | 'rejected' | 'cancelled'

export interface Job {
  id: string
  kind: JobKind
  status: JobStatus
  title: string
  runId?: string
  input: unknown
  result?: unknown
  suspend?: unknown
  /** 実行中の進捗 (ステップが書き込む) */
  progress?: JobProgress
  error?: string
  createdAt: string
  updatedAt: string
}

const WORKFLOW_BY_KIND: Record<Exclude<JobKind, 'solve' | 'answers' | 'edit'>, 'ingestExamWorkflow' | 'analyzeExamWorkflow' | 'generateExamWorkflow'> = {
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
    progress: r.progress_json ? (JSON.parse(String(r.progress_json)) as JobProgress) : undefined,
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

/** 実行中のジョブだけを終了状態にする。停止 (cancelled) された後にワークフローが返ってきても上書きしない */
async function finishJob(id: string, patch: { status: JobStatus; result?: unknown; suspend?: unknown; error?: string }): Promise<void> {
  await getDb().execute(
    `UPDATE jobs SET status = ?, result_json = ?, suspend_json = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'`,
    [patch.status, patch.result === undefined ? null : JSON.stringify(patch.result), patch.suspend === undefined ? null : JSON.stringify(patch.suspend), patch.error ?? null, id],
  )
}

/** 失敗時の記録。停止で投げられたエラーは (すでに cancelled なので) finishJob の条件で無視される */
function failJob(id: string, err: unknown): Promise<void> {
  return finishJob(id, { status: 'failed', error: errorMessage(err) })
}

/** このプロセスで実行中のワークフロー (停止ボタンで cancel する) */
const activeRuns = new Map<string, { cancel(): Promise<void> }>()

/** バックグラウンド処理の後始末 (中止シグナルと実行中ワークフローの登録を外す) */
function settle(id: string): void {
  releaseJobAbort(id)
  activeRuns.delete(id)
}

/** ジョブの状態が操作に合わないときのエラー (HTTP の 404 / 409 に対応) */
export class JobStateError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message)
  }
}

/**
 * 実行中のジョブを停止する。まず DB を cancelled にし (ワークフローの結果で上書きされない)、
 * このプロセスで動いていればモデル呼び出しとワークフローを中止する。
 * サーバ再起動などで実体が無い「実行中」のジョブも、記録だけ cancelled になる。
 */
export async function cancelJob(id: string): Promise<Job> {
  await ensureSchema()
  const rows = await getDb().execute(`UPDATE jobs SET status = 'cancelled', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running' RETURNING id`, [
    '管理者が停止しました',
    id,
  ])
  if (!rows.length) {
    const job = await getJob(id)
    if (!job) throw new JobStateError('ジョブが見つかりません', 404)
    throw new JobStateError(`このジョブは実行中ではないため停止できません (状態: ${job.status})`, 409)
  }
  abortJob(id)
  await activeRuns.get(id)?.cancel().catch(() => undefined)
  return (await getJob(id))!
}

/**
 * ジョブ開始の受付中ロック (このプロセス内)。
 * 「実行中のジョブがあるか」の確認から jobs への登録までの間にはモデルの疎通確認などで数秒かかるため、
 * ボタンの連打で同じリクエストが 2 つ来ると両方とも確認を通ってしまう。その間だけキーを押さえる。
 */
const startingKeys = new Set<string>()

/** keys のどれかが受付中なら undefined を返して何もしない。そうでなければ fn を実行する */
export async function withStartLock<T>(keys: string[], fn: () => Promise<T>): Promise<T | undefined> {
  if (keys.some(k => startingKeys.has(k))) return undefined
  for (const k of keys) startingKeys.add(k)
  try {
    return await fn()
  } finally {
    for (const k of keys) startingKeys.delete(k)
  }
}

export async function getJob(id: string): Promise<Job | undefined> {
  await ensureSchema()
  const rows = await getDb().execute('SELECT * FROM jobs WHERE id = ?', [id])
  return rows[0] ? rowToJob(rows[0]) : undefined
}

export async function listJobs(limit = 50): Promise<Job[]> {
  await ensureSchema()
  await failStaleJobs()
  const rows = await getDb().execute(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ${Math.min(limit, 200)}`)
  return rows.map(rowToJob)
}

/** 進捗の更新が止まってからこの時間を超えた実行中ジョブは、プロセスが死んだものとして失敗扱いにする */
export const STALE_JOB_MS = Number(process.env.KAKOMON_STALE_JOB_MINUTES || 15) * 60 * 1000

/**
 * 実行中のまま進捗 (updated_at) が止まったジョブを failed にする。
 * ステップは思考中・ツール実行中もハートビートを書くので、長時間止まるのはサーバ停止・スリープ・
 * サーバレス上で起動して関数が止まった場合に限られる。実行中のまま残ると二重起動防止に引っかかる。
 */
export async function failStaleJobs(now = Date.now()): Promise<number> {
  const rows = await getDb().execute(`SELECT id, updated_at FROM jobs WHERE status = 'running'`)
  let count = 0
  for (const r of rows) {
    const updated = parseDbTime(str(r.updated_at))
    if (!Number.isFinite(updated) || now - updated < STALE_JOB_MS) continue
    const minutes = Math.round((now - updated) / 60000)
    await getDb().execute(`UPDATE jobs SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'`, [
      `${minutes} 分以上進捗の更新が無いため中断扱いにしました。サーバ (npm run dev) が止まった、PC がスリープした、または Vercel 上で起動した可能性があります。手元のサーバを起動してもう一度実行してください`,
      String(r.id),
    ])
    count++
  }
  return count
}

/** DB の時刻文字列 (Postgres: "2026-10-08 15:12:01.54+00" / libSQL: "2026-10-08 15:12:01", どちらも UTC) をミリ秒にする */
export function parseDbTime(s?: string): number {
  if (!s) return NaN
  let t = s.trim().replace(' ', 'T')
  if (/[+-]\d\d$/.test(t)) t += ':00' // Postgres の "+00" は JS が解釈できないので "+00:00" にする
  else if (!/[zZ]$|[+-]\d\d:\d\d$/.test(t)) t += 'Z'
  return Date.parse(t)
}

/** 実行中のジョブのうち条件に合う最初のもの (二重起動の防止に使う) */
export async function findRunningJob(kind: JobKind, match: (job: Job) => boolean = () => true): Promise<Job | undefined> {
  await ensureSchema()
  const rows = await getDb().execute(`SELECT * FROM jobs WHERE status = 'running' AND kind = ? ORDER BY created_at DESC`, [kind])
  return rows.map(rowToJob).find(match)
}

/** ワークフローの実行結果を jobs に反映する */
async function recordWorkflowResult(jobId: string, res: { status: string; result?: unknown; steps?: Record<string, any>; error?: unknown; suspended?: unknown }) {
  if (res.status === 'success') {
    await finishJob(jobId, { status: 'success', result: res.result })
  } else if (res.status === 'suspended') {
    // 承認待ち: admin-approval ステップの suspendPayload を取り出す
    const step = res.steps?.['admin-approval']
    await finishJob(jobId, { status: 'suspended', suspend: step?.suspendPayload ?? res.suspended, result: step?.payload })
  } else {
    await finishJob(jobId, { status: 'failed', error: errorMessage((res as { error?: unknown }).error) || `workflow status: ${res.status}` })
  }
}

/** ワークフローをバックグラウンドで開始し、ジョブ ID を返す */
export async function startWorkflowJob(mastra: Mastra, kind: Exclude<JobKind, 'solve' | 'answers' | 'edit'>, title: string, input: unknown): Promise<Job> {
  const workflow = mastra.getWorkflow(WORKFLOW_BY_KIND[kind])
  const run = await workflow.createRun()
  const id = randomUUID()
  await insertJob({ id, kind, title, runId: run.runId, input })
  registerJobAbort(id)
  activeRuns.set(id, run)
  // ステップが進捗を jobs に書けるよう、requestContext でジョブ ID を渡す
  const requestContext = new RequestContext()
  requestContext.set(JOB_ID_KEY as never, id as never)
  void run
    .start({ inputData: input as never, requestContext })
    .then(res => recordWorkflowResult(id, res as never))
    .catch(err => failJob(id, err))
    .finally(() => settle(id))
  return (await getJob(id))!
}

/** 承認待ちの generate ジョブを再開する (approved=false なら破棄) */
export async function resumeGenerateJob(mastra: Mastra, jobId: string, resumeData: { approved: boolean; note?: string }): Promise<Job> {
  const job = await getJob(jobId)
  if (!job) throw new JobStateError('ジョブが見つかりません', 404)
  if (job.kind !== 'generate' || !job.runId) throw new JobStateError('このジョブは承認待ちではありません', 409)
  // 承認待ち → 実行中 の切り替えを 1 文で行い、連打で 2 回 resume されないようにする
  const claimed = await getDb().execute(`UPDATE jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'suspended' RETURNING id`, [jobId])
  if (!claimed.length) throw new JobStateError('このジョブは承認待ちではありません (すでに承認・却下済みの可能性があります)', 409)
  const run = await mastra.getWorkflow('generateExamWorkflow').createRun({ runId: job.runId })
  registerJobAbort(jobId)
  activeRuns.set(jobId, run)
  void run
    .resume({ step: adminApprovalStep, resumeData })
    .then(async res => {
      if (res.status === 'success' && !resumeData.approved) await finishJob(jobId, { status: 'rejected', result: res.result })
      else await recordWorkflowResult(jobId, res as never)
    })
    .catch(err => failJob(jobId, err))
    .finally(() => settle(jobId))
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
export async function solveExam(mastra: Mastra, examId: string, jobId?: string) {
  const progress = progressReporter(jobId, '正解と根拠を推定中')
  const rec = await getExam(examId)
  if (!rec) throw new Error(`exam not found: ${examId}`)
  const targets = rec.exam.questions.filter(q => !q.correctLabel || q.choices.some(c => !c.rationale))
  if (!targets.length) return { examId, solved: [], message: 'すべての設問に正解と根拠が付いています' }
  const agent = mastra.getAgentById('exam-reviewer')
  await progress.flush()
  const raw = await streamObject(
    agent,
    `次の過去問設問について、正解の選択肢と、各選択肢が正解/不正解である根拠を示してください。確信が持てない場合は confidence を下げてください。\n\n${JSON.stringify({
      passages: rec.exam.passages,
      questions: targets.map(q => ({ number: q.number, passageId: q.passageId, passage: q.passage, stem: q.stem, choices: q.choices.map(c => ({ label: c.label, text: c.text })) })),
    })}`,
    // 正解推定は採点の正解データになるので、校閲エージェントの既定 (Sonnet) ではなく判断用モデル (Opus) で回す
    { structuredOutput: { schema: solveSchema, jsonPromptInjection: 'auto' }, model: config.model, modelSettings: { maxOutputTokens: 32000 }, providerOptions: anthropicOptions('high') },
    { progress },
  )
  const parsed = solveSchema.parse(raw)
  if (progress.signal?.aborted) throw new JobCancelledError()
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
  registerJobAbort(id)
  void solveExam(mastra, examId, id)
    .then(result => finishJob(id, { status: 'success', result }))
    .catch(err => failJob(id, err))
    .finally(() => settle(id))
  return (await getJob(id))!
}

const answerKeySchema = z.object({
  answers: z.array(
    z.object({
      number: z.number().int().describe('設問番号 (渡した設問一覧の number)'),
      correctLabel: z.string().optional().describe('正解の選択肢ラベル。渡した choices の label と同じ表記で'),
      explanation: z.string().optional().describe('この設問の解説 (PDF に書かれている内容を要約せずに転記)'),
      rationales: z.array(z.object({ label: z.string(), rationale: z.string() })).default([]).describe('選択肢ごとの解説が PDF にあれば'),
    }),
  ),
  notes: z.array(z.string()).default([]).describe('読み取れなかった箇所・設問との対応が不確かな箇所'),
})

/**
 * 解答・解説の PDF を読み取り、登録済みの過去問に正解と解説を付ける。
 * PDF は公式の正解なので、AI 推定 (solve) と違い既存の正解も上書きする。
 */
export async function importAnswerKey(mastra: Mastra, examId: string, filePath: string, jobId?: string) {
  const progress = progressReporter(jobId, '解答 PDF をモデルに送信中')
  const rec = await getExam(examId)
  if (!rec) throw new Error(`exam not found: ${examId}`)
  const pdf = await readFile(filePath)
  const agent = mastra.getAgentById('exam-extractor')
  await progress.flush()
  const raw = await streamObject(
    agent,
    [
      {
        role: 'user',
        content: [
          { type: 'file', data: pdf, mediaType: 'application/pdf', filename: path.basename(filePath) },
          {
            type: 'text',
            text: `この PDF は、下の過去問の「解答・解説」です。設問を構造化するのではなく、各設問の正解の選択肢と解説を読み取ってください。
- number は下の設問一覧の number に合わせる (PDF 側の番号の振り方が違う場合は、問題文・選択肢の内容で対応を取る)
- correctLabel は下の choices の label と同じ表記にする (例: PDF が「1」で choices が「ア」「イ」… の場合は対応する label に直す)
- 解説は PDF の記述をそのまま転記する。PDF に無い設問は answers に含めない。推測で正解を作らない

${JSON.stringify({
  title: rec.exam.title,
  year: rec.exam.year,
  questions: rec.exam.questions.map(q => ({ number: q.number, stem: q.stem.slice(0, 200), choices: q.choices.map(c => ({ label: c.label, text: c.text.slice(0, 80) })) })),
})}`,
          },
        ],
      },
    ],
    {
      structuredOutput: { schema: answerKeySchema, jsonPromptInjection: 'auto' },
      modelSettings: { maxOutputTokens: 64000, maxRetries: 1 },
      providerOptions: anthropicOptions('medium'),
    },
    { progress },
  )
  await progress.setPhase('正解と解説を反映中')
  const parsed = answerKeySchema.parse(raw)
  const notes = [...parsed.notes]
  const changed: { number: number; from?: string; to: string }[] = []
  let applied = 0
  for (const a of parsed.answers) {
    const q = rec.exam.questions.find(q => q.number === a.number)
    if (!q) {
      notes.push(`問${a.number}: 過去問に該当する設問がないため無視しました`)
      continue
    }
    let touched = false
    if (a.correctLabel) {
      const label = q.choices.find(c => c.label === a.correctLabel || c.label.normalize('NFKC') === a.correctLabel!.normalize('NFKC'))?.label
      if (!label) notes.push(`問${a.number}: 正解「${a.correctLabel}」が選択肢 (${q.choices.map(c => c.label).join(', ')}) にないため反映しませんでした`)
      else {
        if (q.correctLabel !== label) changed.push({ number: q.number, from: q.correctLabel, to: label })
        q.correctLabel = label
        touched = true
      }
    }
    if (a.explanation) {
      q.explanation = a.explanation // AI 推定の注記 ([AI推定 confidence=…]) も公式の解説で置き換える
      touched = true
    }
    for (const r of a.rationales) {
      const c = q.choices.find(c => c.label === r.label)
      if (c) {
        c.rationale = r.rationale
        touched = true
      }
    }
    if (touched) applied++
  }
  const covered = new Set(parsed.answers.map(a => a.number))
  const missing = rec.exam.questions.filter(q => !covered.has(q.number)).map(q => q.number)
  if (progress.signal?.aborted) throw new JobCancelledError()
  await saveExam({ id: rec.id, kind: rec.kind, exam: rec.exam, status: rec.status, sourceFile: rec.sourceFile, specId: rec.specId })
  return {
    examId: rec.id,
    applied,
    answeredCount: rec.exam.questions.filter(q => q.correctLabel).length,
    questionCount: rec.exam.questions.length,
    changed,
    missing,
    notes,
  }
}

export async function startAnswerKeyJob(mastra: Mastra, examId: string, filePath: string, title: string): Promise<Job> {
  const id = randomUUID()
  await insertJob({ id, kind: 'answers', title, input: { examId, filePath } })
  registerJobAbort(id)
  void importAnswerKey(mastra, examId, filePath, id)
    .then(result => finishJob(id, { status: 'success', result }))
    .catch(err => failJob(id, err))
    .finally(() => settle(id))
  return (await getJob(id))!
}

/** 予想問題をプロンプトで編集するジョブ (承認待ちの間も実行できる。承認時は編集後の内容が公開される) */
export async function startEditJob(mastra: Mastra, examId: string, prompt: string, title: string): Promise<Job> {
  const id = randomUUID()
  await insertJob({ id, kind: 'edit', title, input: { examId, prompt } })
  registerJobAbort(id)
  void editExamWithPrompt(mastra, examId, prompt, id)
    .then(result => finishJob(id, { status: 'success', result }))
    .catch(err => failJob(id, err))
    .finally(() => settle(id))
  return (await getJob(id))!
}
