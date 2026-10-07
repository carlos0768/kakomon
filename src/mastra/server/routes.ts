import { registerApiRoute } from '@mastra/core/server'
import { z } from 'zod'
import { config } from '../config.ts'
import { createAttempt, getAttempt, getExam, getWeaknessReport, listAttempts, listExams, listSpecs, updateExamStatus } from '../db/repo.ts'
import { answerSchema } from '../schemas/grading.ts'
import { toPublicQuestion } from '../schemas/exam.ts'
import { MIN_ATTEMPTS_FOR_WEAKNESS } from '../services/weakness.ts'
import { adminApprovalStep } from '../workflows/generate-exam.workflow.ts'
import { userUiHtml } from './ui.ts'

/**
 * HTTP ルート。
 * - /kakomon/*        … 受験者向け (公開済み予想問題の閲覧・解答・添削・弱点分析)。正解は返さない。
 * - /kakomon/admin/*  … 管理者向け (下書きの承認など)。KAKOMON_ADMIN_TOKEN があれば Bearer 認証。
 * 作問・分析そのものは Mastra 標準の /api/workflows/* (Studio) か CLI から実行する。
 */

const adminAuth = async (c: any, next: () => Promise<void>) => {
  if (config.adminToken) {
    const auth = c.req.header('authorization') ?? ''
    if (auth !== `Bearer ${config.adminToken}`) return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
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
        questions: rec.exam.questions.map(toPublicQuestion),
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

  // ---- 受験開始 ----
  registerApiRoute('/kakomon/attempts', {
    method: 'POST',
    requiresAuth: false,
    handler: async c => {
      const body = z.object({ userId: z.string().min(1), examId: z.string().min(1) }).safeParse(await c.req.json())
      if (!body.success) return c.json({ error: body.error.issues }, 400)
      const rec = await getExam(body.data.examId)
      if (!rec || rec.kind !== 'predicted' || rec.status !== 'published') return c.json({ error: 'exam not found' }, 404)
      const attempt = await createAttempt(body.data)
      return c.json({ attemptId: attempt.id, examId: attempt.examId, startedAt: attempt.startedAt })
    },
  }),

  // ---- 解答提出 → 添削 ----
  registerApiRoute('/kakomon/attempts/:attemptId/submit', {
    method: 'POST',
    requiresAuth: false,
    handler: async c => {
      const attemptId = c.req.param('attemptId')
      const body = z.object({ answers: z.array(answerSchema) }).safeParse(await c.req.json())
      if (!body.success) return c.json({ error: body.error.issues }, 400)
      const attempt = await getAttempt(attemptId)
      if (!attempt) return c.json({ error: 'attempt not found' }, 404)
      if (attempt.status === 'submitted') return c.json({ error: 'already submitted', result: attempt.result }, 409)
      const mastra = c.get('mastra')
      const run = await mastra.getWorkflow('gradeAttemptWorkflow').createRun()
      const res = await run.start({ inputData: { attemptId, answers: body.data.answers } })
      if (res.status !== 'success') return c.json({ error: 'grading failed', status: res.status }, 500)
      return c.json(res.result)
    },
  }),

  // ---- 採点結果の再取得 ----
  registerApiRoute('/kakomon/attempts/:attemptId', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => {
      const attempt = await getAttempt(c.req.param('attemptId'))
      if (!attempt) return c.json({ error: 'attempt not found' }, 404)
      return c.json(attempt)
    },
  }),

  // ---- 受験履歴 ----
  registerApiRoute('/kakomon/users/:userId/attempts', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => {
      const attempts = await listAttempts(c.req.param('userId'))
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

  // ---- 弱点分析 (2 回以上の受験が必要) ----
  registerApiRoute('/kakomon/users/:userId/weakness', {
    method: 'POST',
    requiresAuth: false,
    handler: async c => {
      const userId = c.req.param('userId')
      const submitted = (await listAttempts(userId, 'submitted')).length
      if (submitted < MIN_ATTEMPTS_FOR_WEAKNESS) {
        return c.json({ error: `弱点分析には ${MIN_ATTEMPTS_FOR_WEAKNESS} 回以上の受験が必要です`, attempts: submitted }, 400)
      }
      const mastra = c.get('mastra')
      const run = await mastra.getWorkflow('weaknessWorkflow').createRun()
      const res = await run.start({ inputData: { userId } })
      if (res.status !== 'success') return c.json({ error: 'analysis failed', status: res.status }, 500)
      return c.json(res.result)
    },
  }),
  registerApiRoute('/kakomon/users/:userId/weakness', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => {
      const report = await getWeaknessReport(c.req.param('userId'))
      return report ? c.json(report) : c.json({ error: 'no report yet' }, 404)
    },
  }),

  // ---- 管理者: 要件定義・下書き一覧 ----
  registerApiRoute('/kakomon/admin/specs', {
    method: 'GET',
    middleware: [adminAuth],
    handler: async c => c.json({ specs: await listSpecs() }),
  }),
  registerApiRoute('/kakomon/admin/exams', {
    method: 'GET',
    middleware: [adminAuth],
    handler: async c => {
      const exams = await listExams()
      return c.json({
        exams: exams.map(e => ({ examId: e.id, kind: e.kind, status: e.status, title: e.title, year: e.year, questionCount: e.exam.questions.length, specId: e.specId })),
      })
    },
  }),

  // ---- 管理者: 承認待ちワークフローの resume ----
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

  // ---- 管理者: 公開/非公開の切替 ----
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
]
