import type { Mastra } from '@mastra/core'
import { registerApiRoute } from '@mastra/core/server'
import { z } from 'zod'
import { config } from '../config.ts'
import { ensureSchema, getDb } from '../db/client.ts'
import { createAttempt, getAttempt, getExam, getWeaknessReport, listAttempts, listExams, listSpecs, renameExam, updateExamStatus } from '../db/repo.ts'
import { answerSchema } from '../schemas/grading.ts'
import { toPublicQuestion, type ExtractedExam } from '../schemas/exam.ts'
import {
  AuthError,
  authenticate,
  clearSessionCookie,
  createSession,
  deleteSession,
  getUserBySession,
  readCookie,
  registerUser,
  SESSION_COOKIE,
  sessionCookie,
  type User,
} from '../services/auth.ts'
import { MIN_ATTEMPTS_FOR_WEAKNESS } from '../services/weakness.ts'
import { adminApprovalStep } from '../workflows/generate-exam.workflow.ts'
import { userUiHtml } from './ui.ts'
import { adminUiHtml } from './admin-ui.ts'
import { cancelJob, findRunningJob, getJob, JobStateError, listJobs, resumeGenerateJob, startAnswerKeyJob, startEditJob, startSolveJob, startWorkflowJob, withStartLock } from '../services/jobs.ts'
import { editBlockReason } from '../services/exam-edit.ts'
import { PreflightError, preflightModel } from '../services/preflight.ts'
import { listUsers, resetPassword } from '../services/auth.ts'
import { getSpec } from '../db/repo.ts'
import { specToMarkdown } from '../services/spec-markdown.ts'
import { renderExamHtml } from '../render/html.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * HTTP ルート。
 * - /kakomon/*        … 受験者向け。ユーザー名+パスワードの簡易アカウント (Cookie セッション)。正解は返さない。
 * - /kakomon/admin/*  … 管理者向け (下書きの承認など)。KAKOMON_ADMIN_TOKEN があれば Bearer 認証。
 * 作問・分析そのものは Mastra 標準の /api/workflows/* (Studio) か CLI から実行する。
 */

/** 連打などで同じ開始リクエストが同時に来たときの応答 */
const STARTING = '同じ処理の開始を受け付けている途中です。数秒待ってからジョブ一覧を確認してください'

/** アップロードされた PDF を uploadDir に保存してパスを返す */
async function saveUpload(file: File, prefix?: string): Promise<string> {
  await mkdir(config.uploadDir, { recursive: true })
  const safeName = file.name.replace(/[^\w.\-\u3000-\u9fff]/g, '_')
  const filePath = path.join(config.uploadDir, `${Date.now()}-${randomUUID().slice(0, 8)}-${prefix ? `${prefix}-` : ''}${safeName}`)
  await writeFile(filePath, Buffer.from(await file.arrayBuffer()))
  return filePath
}

/** 正解推定と正解インポートは同じ過去問を書き換えるので、どちらかが実行中なら始めない */
async function findAnswerJob(examId: string) {
  const sameExam = (j: { input: unknown }) => (j.input as { examId?: string }).examId === examId
  return (await findRunningJob('solve', sameExam)) ?? (await findRunningJob('answers', sameExam))
}

/**
 * ジョブ開始前の共通チェック。
 * 1) Vercel などのサーバレス上では応答を返した直後に関数が止まり、バックグラウンドのジョブは途中で死ぬ
 *    (記録だけ「実行中」のまま残る) ので、重いジョブはそもそも始めない。
 * 2) モデル API の疎通 (キー・残高) を確認し、ダメなら 400 の Response を返す
 */
async function preflightOr400(c: { get(key: 'mastra'): Mastra; json: (body: unknown, status: 400) => Response }): Promise<Response | undefined> {
  if (config.isServerless && process.env.KAKOMON_ALLOW_SERVERLESS_JOBS !== '1') {
    return c.json(
      {
        error:
          'Vercel 上では取り込み・分析・作問・正解推定を実行できません (応答を返した直後に関数が止まり、ジョブが途中で死にます)。手元で npm run dev を起動した管理画面 (http://localhost:4111/kakomon/admin) から実行してください。承認・公開切替・ユーザー管理はここでできます。',
      },
      400,
    )
  }
  try {
    await preflightModel(c.get('mastra'))
    return undefined
  } catch (err) {
    return c.json({ error: err instanceof PreflightError ? err.message : String(err) }, 400)
  }
}

const adminAuth = async (c: any, next: () => Promise<void>) => {
  if (config.adminToken) {
    const auth = c.req.header('authorization') ?? ''
    if (auth !== `Bearer ${config.adminToken}`) return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
}

/** Cookie のセッションからログイン中の受験者を取り出す */
async function currentUser(c: any): Promise<User | undefined> {
  return getUserBySession(readCookie(c.req.header('cookie'), SESSION_COOKIE))
}

function isSecureRequest(c: any): boolean {
  const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '')
  return proto === 'https'
}

const credentialsSchema = z.object({ username: z.string().min(1), password: z.string().min(1) })

function publicUser(u: User) {
  return { userId: u.id, username: u.username }
}

/** 問題/解答を別ファイルの HTML としてダウンロードさせるレスポンス (印刷→PDF 保存もできる) */
function downloadHtml(c: { header(k: string, v: string): void; body(b: string): Response }, exam: ExtractedExam, examId: string, kind: 'questions' | 'answers') {
  const answers = kind === 'answers'
  const html = renderExamHtml(exam, { withAnswers: answers, titleSuffix: answers ? '【解答・解説】' : '【問題】' })
  const label = answers ? '解答' : '問題'
  const name = `${exam.title}_${label}.html`
  c.header('Content-Type', 'text/html; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="${examId}-${kind}.html"; filename*=UTF-8''${encodeURIComponent(name)}`)
  return c.body(html)
}

export const apiRoutes = [
  // ---- ルート: Studio が無い本番環境では受験者 UI へ ----
  ...(process.env.NODE_ENV === 'production' && !process.env.VERCEL
    ? [
        registerApiRoute('/', {
          method: 'GET',
          requiresAuth: false,
          handler: async c => c.redirect('/kakomon'),
        }),
      ]
    : []),

  // ---- 受験者 UI (静的 1 ページ) ----
  registerApiRoute('/kakomon', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => c.html(userUiHtml()),
  }),

  // ---- 動作確認: DB 設定と接続状態 (秘密情報は返さない) ----
  registerApiRoute('/kakomon/health', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => {
      const info: Record<string, unknown> = {
        dbDialect: config.dbDialect,
        dbConfigured: Boolean(process.env.KAKOMON_DB_URL),
        ephemeralDb: config.ephemeralDb,
        serverless: config.isServerless,
        adminTokenConfigured: Boolean(config.adminToken),
        anthropicKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      }
      try {
        await ensureSchema()
        const rows = await getDb().execute('SELECT COUNT(*) AS n FROM users')
        info.db = 'ok'
        info.users = Number(rows[0]?.n ?? 0)
      } catch (err) {
        info.db = 'error'
        info.dbError = err instanceof Error ? err.message : String(err)
      }
      return c.json(info, info.db === 'ok' ? 200 : 500)
    },
  }),

  // ---- アカウント: 登録 / ログイン / ログアウト / 自分 ----
  registerApiRoute('/kakomon/auth/register', {
    method: 'POST',
    requiresAuth: false,
    handler: async c => {
      const body = credentialsSchema.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: 'ユーザー名とパスワードを入力してください' }, 400)
      try {
        const user = await registerUser(body.data.username, body.data.password)
        const session = await createSession(user.id)
        c.header('Set-Cookie', sessionCookie(session.token, session.expiresAt, isSecureRequest(c)))
        return c.json(publicUser(user), 201)
      } catch (err) {
        if (err instanceof AuthError) return c.json({ error: err.message }, err.status)
        console.error('[kakomon] register failed', err)
        return c.json({ error: `登録に失敗しました (サーバ側のエラー): ${err instanceof Error ? err.message : String(err)}` }, 500)
      }
    },
  }),
  registerApiRoute('/kakomon/auth/login', {
    method: 'POST',
    requiresAuth: false,
    handler: async c => {
      const body = credentialsSchema.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: 'ユーザー名とパスワードを入力してください' }, 400)
      try {
        const user = await authenticate(body.data.username, body.data.password)
        const session = await createSession(user.id)
        c.header('Set-Cookie', sessionCookie(session.token, session.expiresAt, isSecureRequest(c)))
        return c.json(publicUser(user))
      } catch (err) {
        if (err instanceof AuthError) return c.json({ error: err.message }, err.status)
        console.error('[kakomon] login failed', err)
        return c.json({ error: `ログインに失敗しました (サーバ側のエラー): ${err instanceof Error ? err.message : String(err)}` }, 500)
      }
    },
  }),
  registerApiRoute('/kakomon/auth/logout', {
    method: 'POST',
    requiresAuth: false,
    handler: async c => {
      await deleteSession(readCookie(c.req.header('cookie'), SESSION_COOKIE))
      c.header('Set-Cookie', clearSessionCookie(isSecureRequest(c)))
      return c.json({ ok: true })
    },
  }),
  registerApiRoute('/kakomon/auth/me', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => {
      const user = await currentUser(c)
      return user ? c.json(publicUser(user)) : c.json({ error: 'not logged in' }, 401)
    },
  }),

  // ---- 公開済み予想問題の一覧 ----
  registerApiRoute('/kakomon/exams', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => {
      const exams = await listExams({ kind: 'predicted', status: 'published' })
      return c.json({
        exams: exams.map(e => ({
          examId: e.id,
          title: e.title,
          year: e.year,
          questionCount: e.exam.questions.length,
          timeLimitMinutes: e.exam.timeLimitMinutes,
          publishedAt: e.updatedAt,
        })),
      })
    },
  }),

  // ---- 問題本文 (正解・解説なし) ----
  registerApiRoute('/kakomon/exams/:examId', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => {
      const rec = await getExam(c.req.param('examId'))
      if (!rec || rec.kind !== 'predicted' || rec.status !== 'published') return c.json({ error: 'not found' }, 404)
      return c.json({
        examId: rec.id,
        title: rec.title,
        instructions: rec.exam.instructions,
        timeLimitMinutes: rec.exam.timeLimitMinutes,
        layout: rec.exam.layout,
        questions: rec.exam.questions.map(q => toPublicQuestion(q, rec.exam.passages)),
        printableHtmlUrl: `/kakomon/exams/${rec.id}/print`,
      })
    },
  }),

  // ---- 原本の見た目を再現した印刷用 HTML ----
  registerApiRoute('/kakomon/exams/:examId/print', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => {
      const rec = await getExam(c.req.param('examId'))
      if (!rec || rec.kind !== 'predicted' || rec.status !== 'published') return c.text('not found', 404)
      const { renderExamHtml } = await import('../render/html.ts')
      return c.html(renderExamHtml(rec.exam))
    },
  }),

  // ---- 問題のダウンロード (正解は含まない。解答は管理者のみ) ----
  registerApiRoute('/kakomon/exams/:examId/download', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => {
      const rec = await getExam(c.req.param('examId'))
      if (!rec || rec.kind !== 'predicted' || rec.status !== 'published') return c.text('not found', 404)
      return downloadHtml(c, rec.exam, rec.id, 'questions')
    },
  }),

  // ---- 受験開始 (要ログイン) ----
  registerApiRoute('/kakomon/attempts', {
    method: 'POST',
    requiresAuth: false,
    handler: async c => {
      const user = await currentUser(c)
      if (!user) return c.json({ error: 'ログインしてください' }, 401)
      const body = z.object({ examId: z.string().min(1) }).safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: body.error.issues }, 400)
      const rec = await getExam(body.data.examId)
      if (!rec || rec.kind !== 'predicted' || rec.status !== 'published') return c.json({ error: 'exam not found' }, 404)
      const attempt = await createAttempt({ userId: user.id, examId: rec.id })
      return c.json({ attemptId: attempt.id, examId: attempt.examId, startedAt: attempt.startedAt })
    },
  }),

  // ---- 解答提出 → 添削 (本人のみ) ----
  registerApiRoute('/kakomon/attempts/:attemptId/submit', {
    method: 'POST',
    requiresAuth: false,
    handler: async c => {
      const user = await currentUser(c)
      if (!user) return c.json({ error: 'ログインしてください' }, 401)
      const attemptId = c.req.param('attemptId')
      const body = z.object({ answers: z.array(answerSchema) }).safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: body.error.issues }, 400)
      const attempt = await getAttempt(attemptId)
      if (!attempt || attempt.userId !== user.id) return c.json({ error: 'attempt not found' }, 404)
      if (attempt.status === 'submitted') return c.json({ error: 'already submitted', result: attempt.result }, 409)
      const mastra = c.get('mastra')
      const run = await mastra.getWorkflow('gradeAttemptWorkflow').createRun()
      const res = await run.start({ inputData: { attemptId, answers: body.data.answers } })
      if (res.status !== 'success') return c.json({ error: 'grading failed', status: res.status }, 500)
      return c.json(res.result)
    },
  }),

  // ---- 採点結果の再取得 (本人のみ) ----
  registerApiRoute('/kakomon/attempts/:attemptId', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => {
      const user = await currentUser(c)
      if (!user) return c.json({ error: 'ログインしてください' }, 401)
      const attempt = await getAttempt(c.req.param('attemptId'))
      if (!attempt || attempt.userId !== user.id) return c.json({ error: 'attempt not found' }, 404)
      return c.json(attempt)
    },
  }),

  // ---- 自分の受験履歴 ----
  registerApiRoute('/kakomon/me/attempts', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => {
      const user = await currentUser(c)
      if (!user) return c.json({ error: 'ログインしてください' }, 401)
      const attempts = await listAttempts(user.id)
      return c.json({
        attempts: attempts.map(a => ({
          attemptId: a.id,
          examId: a.examId,
          status: a.status,
          score: a.result?.score,
          total: a.result?.total,
          percentage: a.result?.percentage,
          submittedAt: a.submittedAt,
        })),
        canAnalyzeWeakness: attempts.filter(a => a.status === 'submitted').length >= MIN_ATTEMPTS_FOR_WEAKNESS,
        minAttemptsForWeakness: MIN_ATTEMPTS_FOR_WEAKNESS,
      })
    },
  }),

  // ---- 自分の弱点分析 (2 回以上の受験が必要) ----
  registerApiRoute('/kakomon/me/weakness', {
    method: 'POST',
    requiresAuth: false,
    handler: async c => {
      const user = await currentUser(c)
      if (!user) return c.json({ error: 'ログインしてください' }, 401)
      const submitted = (await listAttempts(user.id, 'submitted')).length
      if (submitted < MIN_ATTEMPTS_FOR_WEAKNESS) {
        return c.json({ error: `弱点分析には ${MIN_ATTEMPTS_FOR_WEAKNESS} 回以上の受験が必要です`, attempts: submitted }, 400)
      }
      const mastra = c.get('mastra')
      const run = await mastra.getWorkflow('weaknessWorkflow').createRun()
      const res = await run.start({ inputData: { userId: user.id } })
      if (res.status !== 'success') return c.json({ error: 'analysis failed', status: res.status }, 500)
      return c.json(res.result)
    },
  }),
  registerApiRoute('/kakomon/me/weakness', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => {
      const user = await currentUser(c)
      if (!user) return c.json({ error: 'ログインしてください' }, 401)
      const report = await getWeaknessReport(user.id)
      return report ? c.json(report) : c.json({ error: 'no report yet' }, 404)
    },
  }),

  // ======================= 管理者 =======================
  // 管理画面 (静的 1 ページ)。API 呼び出し時に Bearer トークンを付ける
  registerApiRoute('/kakomon/admin', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => c.html(adminUiHtml()),
  }),

  // ---- 認証確認 (トークンが合っているか) ----
  registerApiRoute('/kakomon/admin/whoami', {
    method: 'GET',
    middleware: [adminAuth],
    handler: async c =>
      c.json({
        ok: true,
        authRequired: Boolean(config.adminToken),
        dbDialect: config.dbDialect,
        serverless: config.isServerless,
        // Vercel の関数はリクエスト本文 4.5MB が上限 (プラットフォーム側の制限で変更不可)
        maxUploadBytes: config.isServerless ? Math.min(config.maxUploadBytes, 4 * 1024 * 1024) : config.maxUploadBytes,
      }),
  }),

  // ---- 過去問・予想問題の一覧 / 詳細 ----
  registerApiRoute('/kakomon/admin/exams', {
    method: 'GET',
    middleware: [adminAuth],
    handler: async c => {
      const exams = await listExams()
      return c.json({
        exams: exams.map(e => ({
          examId: e.id,
          kind: e.kind,
          status: e.status,
          title: e.title,
          year: e.year,
          session: e.session,
          questionCount: e.exam.questions.length,
          answeredCount: e.exam.questions.filter(q => q.correctLabel).length,
          specId: e.specId,
          extractionNotes: e.exam.extractionNotes,
          updatedAt: e.updatedAt,
        })),
      })
    },
  }),
  registerApiRoute('/kakomon/admin/exams/:examId/preview', {
    method: 'GET',
    middleware: [adminAuth],
    handler: async c => {
      const rec = await getExam(c.req.param('examId'))
      if (!rec) return c.text('not found', 404)
      return c.html(renderExamHtml(rec.exam, { withAnswers: c.req.query('answers') !== '0' }))
    },
  }),
  // 問題 (kind=questions) と解答・解説 (kind=answers) を別ファイルでダウンロード
  registerApiRoute('/kakomon/admin/exams/:examId/download', {
    method: 'GET',
    middleware: [adminAuth],
    handler: async c => {
      const rec = await getExam(c.req.param('examId'))
      if (!rec) return c.text('not found', 404)
      return downloadHtml(c, rec.exam, rec.id, c.req.query('kind') === 'answers' ? 'answers' : 'questions')
    },
  }),
  registerApiRoute('/kakomon/admin/exams/:examId/status', {
    method: 'POST',
    middleware: [adminAuth],
    handler: async c => {
      const body = z.object({ status: z.enum(['draft', 'review', 'published', 'archived']) }).safeParse(await c.req.json())
      if (!body.success) return c.json({ error: body.error.issues }, 400)
      await updateExamStatus(c.req.param('examId'), body.data.status)
      return c.json({ ok: true })
    },
  }),
  registerApiRoute('/kakomon/admin/exams/:examId/title', {
    method: 'POST',
    middleware: [adminAuth],
    handler: async c => {
      const body = z.object({ title: z.string().trim().min(1).max(200) }).safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: '試験名を入力してください (200 文字まで)' }, 400)
      const examId = c.req.param('examId')
      // 実行中のジョブは読み込んだ時点の内容 (旧名称) で保存し直すので、その間は変更を受け付けない
      if ((await findAnswerJob(examId)) ?? (await findRunningJob('edit', j => (j.input as { examId?: string }).examId === examId)))
        return c.json({ error: 'この試験の正解推定・正解インポート・編集が実行中です。終わってから名称を変更してください' }, 409)
      const rec = await renameExam(examId, body.data.title)
      return rec ? c.json({ ok: true, title: rec.title }) : c.json({ error: 'exam not found' }, 404)
    },
  }),
  registerApiRoute('/kakomon/admin/exams/:examId/solve', {
    method: 'POST',
    middleware: [adminAuth],
    handler: async c => {
      const rec = await getExam(c.req.param('examId'))
      if (!rec) return c.json({ error: 'exam not found' }, 404)
      const res = await withStartLock([`answers:${rec.id}`], async () => {
        if (await findAnswerJob(rec.id)) return c.json({ error: 'この過去問の正解推定・正解データのインポートがすでに実行中です' }, 409)
        const pre = await preflightOr400(c)
        if (pre) return pre
        const job = await startSolveJob(c.get('mastra'), rec.id, `正解推定: ${rec.title}`)
        return c.json({ job })
      })
      return res ?? c.json({ error: STARTING }, 409)
    },
  }),
  // ---- 解答・解説 PDF のインポート → 正解データとして過去問に反映 ----
  registerApiRoute('/kakomon/admin/exams/:examId/answers', {
    method: 'POST',
    middleware: [adminAuth],
    handler: async c => {
      const rec = await getExam(c.req.param('examId'))
      if (!rec) return c.json({ error: 'exam not found' }, 404)
      const body = await c.req.parseBody()
      const file = body['file']
      if (!(file instanceof File)) return c.json({ error: '解答・解説の PDF ファイルを選択してください' }, 400)
      if (file.size > config.maxUploadBytes) return c.json({ error: `PDF は ${Math.floor(config.maxUploadBytes / 1024 / 1024)}MB 以下にしてください` }, 400)
      const res = await withStartLock([`answers:${rec.id}`], async () => {
        if (await findAnswerJob(rec.id)) return c.json({ error: 'この過去問の正解推定・正解データのインポートがすでに実行中です' }, 409)
        const pre = await preflightOr400(c)
        if (pre) return pre
        const filePath = await saveUpload(file, 'answers')
        const job = await startAnswerKeyJob(c.get('mastra'), rec.id, filePath, `正解インポート: ${rec.title}${rec.exam.year ? ` (${rec.exam.year})` : ''}`)
        return c.json({ job })
      })
      return res ?? c.json({ error: STARTING }, 409)
    },
  }),

  // ---- 予想問題をプロンプトで編集 (公開前のみ) ----
  registerApiRoute('/kakomon/admin/exams/:examId/edit', {
    method: 'POST',
    middleware: [adminAuth],
    handler: async c => {
      const body = z.object({ prompt: z.string().trim().min(1) }).safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: '編集の指示を入力してください' }, 400)
      const rec = await getExam(c.req.param('examId'))
      const blocked = editBlockReason(rec)
      if (blocked || !rec) return c.json({ error: blocked }, rec ? 400 : 404)
      const res = await withStartLock([`edit:${rec.id}`], async () => {
        // 同じ予想問題への編集が重なると、後から終わった方が先の編集を上書きしてしまう
        if (await findRunningJob('edit', j => (j.input as { examId?: string }).examId === rec.id)) return c.json({ error: 'この予想問題の編集はすでに実行中です。終わるまで待ってください' }, 409)
        // 作問中の下書きは、作問ジョブがバッチごとに上書き保存するので編集を受け付けない
        if (rec.status === 'draft' && (await findRunningJob('generate'))) return c.json({ error: '作問ジョブが実行中です。作問が終わって承認待ちになってから編集してください' }, 409)
        const pre = await preflightOr400(c)
        if (pre) return pre
        const job = await startEditJob(c.get('mastra'), rec.id, body.data.prompt, `編集: ${rec.title}`)
        return c.json({ job })
      })
      return res ?? c.json({ error: STARTING }, 409)
    },
  }),

  // ---- 過去問 PDF のアップロード → 取り込みジョブ ----
  registerApiRoute('/kakomon/admin/upload', {
    method: 'POST',
    middleware: [adminAuth],
    handler: async c => {
      const body = await c.req.parseBody()
      const file = body['file']
      if (!(file instanceof File)) return c.json({ error: 'PDF ファイルを選択してください' }, 400)
      if (file.size > config.maxUploadBytes) return c.json({ error: `PDF は ${Math.floor(config.maxUploadBytes / 1024 / 1024)}MB 以下にしてください` }, 400)
      const title0 = typeof body['title'] === 'string' && body['title'] ? body['title'] : undefined
      const year0 = typeof body['year'] === 'string' && body['year'] ? Number(body['year']) : undefined
      const safeName = file.name.replace(/[^\w.\-\u3000-\u9fff]/g, '_')
      const lockKeys = [`ingest:file:${safeName}`, ...(title0 ? [`ingest:title:${title0}:${year0 ?? ''}`] : [])]
      const res = await withStartLock(lockKeys, async () => {
        // 同じ過去問 (同じファイル名、または同じ試験名+年度) の取り込みが走っていれば二重起動しない (費用が倍になる)
        const dup = await findRunningJob('ingest', j => {
          const input = j.input as { filePath?: string; title?: string; year?: number }
          const sameFile = Boolean(input.filePath && path.basename(input.filePath).endsWith(safeName))
          const sameTitle = Boolean(title0 && input.title === title0 && (year0 ?? null) === (input.year ?? null))
          return sameFile || sameTitle
        })
        if (dup) return c.json({ error: `同じ過去問の取り込みがすでに実行中です (${dup.title})。終わるまで待ってください` }, 409)
        const pre = await preflightOr400(c)
        if (pre) return pre
        const filePath = await saveUpload(file)
        const title = title0
        const year = year0
        const session = typeof body['session'] === 'string' && body['session'] ? body['session'] : undefined
        const job = await startWorkflowJob(c.get('mastra'), 'ingest', `取り込み: ${title ?? file.name}${year ? ` (${year})` : ''}`, {
          filePath,
          kind: 'past',
          title,
          year: Number.isFinite(year) ? year : undefined,
          session,
        })
        return c.json({ job })
      })
      return res ?? c.json({ error: STARTING }, 409)
    },
  }),

  // ---- 要件定義 ----
  registerApiRoute('/kakomon/admin/specs', {
    method: 'GET',
    middleware: [adminAuth],
    handler: async c => {
      const specs = await listSpecs()
      return c.json({
        specs: specs.map(s => ({
          specId: s.id,
          title: s.title,
          status: s.status,
          summary: s.spec.summary,
          questionCount: s.spec.format.questionCount,
          domains: s.spec.domains.map(d => ({ domain: d.domain, share: d.share })),
          sourceExamIds: s.spec.sourceExamIds,
          createdAt: s.createdAt,
        })),
      })
    },
  }),
  registerApiRoute('/kakomon/admin/specs/:specId/markdown', {
    method: 'GET',
    middleware: [adminAuth],
    handler: async c => {
      const rec = await getSpec(c.req.param('specId'))
      if (!rec) return c.text('not found', 404)
      return c.text(specToMarkdown(rec.spec, rec.id))
    },
  }),
  registerApiRoute('/kakomon/admin/analyze', {
    method: 'POST',
    middleware: [adminAuth],
    handler: async c => {
      const body = z
        .object({ title: z.string().optional(), focus: z.string().optional(), examIds: z.array(z.string()).optional(), specId: z.string().optional() })
        .safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: body.error.issues }, 400)
      if (body.data.examIds) {
        // 画面から選んだ過去問だけを対象にする。存在しない ID や予想問題の ID は弾く
        const past = await listExams({ kind: 'past' })
        const unknown = body.data.examIds.filter(id => !past.some(e => e.id === id))
        if (unknown.length) return c.json({ error: `分析対象の過去問が見つかりません: ${unknown.join(', ')}` }, 400)
        if (body.data.examIds.length === 0) return c.json({ error: '分析対象の過去問を 1 件以上選んでください' }, 400)
      }
      const res = await withStartLock(['analyze'], async () => {
        if (await findRunningJob('analyze')) return c.json({ error: '傾向分析がすでに実行中です。終わるまで待ってください' }, 409)
        const pre = await preflightOr400(c)
        if (pre) return pre
        const job = await startWorkflowJob(c.get('mastra'), 'analyze', `傾向分析${body.data.title ? `: ${body.data.title}` : ''}`, body.data)
        return c.json({ job })
      })
      return res ?? c.json({ error: STARTING }, 409)
    },
  }),

  // ---- 予想問題の生成 / 承認 ----
  registerApiRoute('/kakomon/admin/generate', {
    method: 'POST',
    middleware: [adminAuth],
    handler: async c => {
      const body = z
        .object({
          specId: z.string().min(1),
          title: z.string().min(1),
          referenceExamId: z.string().optional(),
          questionCount: z.number().int().min(1).optional(),
          instructions: z.string().optional(),
          maxRevisions: z.number().int().min(0).max(3).default(1),
        })
        .safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: body.error.issues }, 400)
      const { specId, title } = body.data
      const res = await withStartLock([`generate:${specId}:${title}`], async () => {
        // 同じ要件定義・同じタイトルの作問が走っていれば二重起動しない (費用が倍になる)
        const dup = await findRunningJob('generate', j => {
          const input = j.input as { specId?: string; title?: string }
          return input.specId === specId && input.title === title
        })
        if (dup) return c.json({ error: `同じ作問がすでに実行中です (${dup.title})。終わるまで待つか、ジョブを停止してください` }, 409)
        const pre = await preflightOr400(c)
        if (pre) return pre
        const job = await startWorkflowJob(c.get('mastra'), 'generate', `作問: ${title}`, body.data)
        return c.json({ job })
      })
      return res ?? c.json({ error: STARTING }, 409)
    },
  }),
  registerApiRoute('/kakomon/admin/jobs', {
    method: 'GET',
    middleware: [adminAuth],
    handler: async c => c.json({ jobs: await listJobs() }),
  }),
  registerApiRoute('/kakomon/admin/jobs/:jobId', {
    method: 'GET',
    middleware: [adminAuth],
    handler: async c => {
      const job = await getJob(c.req.param('jobId'))
      return job ? c.json({ job }) : c.json({ error: 'job not found' }, 404)
    },
  }),
  registerApiRoute('/kakomon/admin/jobs/:jobId/approve', {
    method: 'POST',
    middleware: [adminAuth],
    handler: async c => {
      const body = z.object({ approved: z.boolean(), note: z.string().optional() }).safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: body.error.issues }, 400)
      try {
        const job = await resumeGenerateJob(c.get('mastra'), c.req.param('jobId'), body.data)
        return c.json({ job })
      } catch (err) {
        if (err instanceof JobStateError) return c.json({ error: err.message }, err.status)
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
      }
    },
  }),
  registerApiRoute('/kakomon/admin/jobs/:jobId/cancel', {
    method: 'POST',
    middleware: [adminAuth],
    handler: async c => {
      try {
        return c.json({ job: await cancelJob(c.req.param('jobId')) })
      } catch (err) {
        if (err instanceof JobStateError) return c.json({ error: err.message }, err.status)
        throw err
      }
    },
  }),

  // ---- 受験者アカウント管理 ----
  registerApiRoute('/kakomon/admin/users', {
    method: 'GET',
    middleware: [adminAuth],
    handler: async c => c.json({ users: await listUsers() }),
  }),
  registerApiRoute('/kakomon/admin/users/:username/reset-password', {
    method: 'POST',
    middleware: [adminAuth],
    handler: async c => {
      const body = z.object({ password: z.string().min(1) }).safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: body.error.issues }, 400)
      try {
        await resetPassword(c.req.param('username'), body.data.password)
        return c.json({ ok: true })
      } catch (err) {
        if (err instanceof AuthError) return c.json({ error: err.message }, err.status)
        throw err
      }
    },
  }),

  // ---- 互換: 旧 runId ベースの承認 (CLI と同じ) ----
  registerApiRoute('/kakomon/admin/runs/:runId/approve', {
    method: 'POST',
    middleware: [adminAuth],
    handler: async c => {
      const body = z.object({ approved: z.boolean(), note: z.string().optional() }).safeParse(await c.req.json())
      if (!body.success) return c.json({ error: body.error.issues }, 400)
      const mastra = c.get('mastra')
      const run = await mastra.getWorkflow('generateExamWorkflow').createRun({ runId: c.req.param('runId') })
      const res = await run.resume({ step: adminApprovalStep, resumeData: body.data })
      return c.json({ status: res.status, result: res.status === 'success' ? res.result : undefined })
    },
  }),
]
