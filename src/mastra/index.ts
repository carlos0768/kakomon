import { Mastra } from '@mastra/core'
import { SimpleAuth } from '@mastra/core/server'
import { VercelDeployer } from '@mastra/deployer-vercel'
import { LibSQLStore } from '@mastra/libsql'
import { analystAgent } from './agents/analyst-agent.ts'
import { coachAgent } from './agents/coach-agent.ts'
import { extractorAgent } from './agents/extractor-agent.ts'
import { generatorAgent } from './agents/generator-agent.ts'
import { graderAgent } from './agents/grader-agent.ts'
import { reviewerAgent } from './agents/reviewer-agent.ts'
import { config } from './config.ts'
import { apiRoutes } from './server/routes.ts'
import { vectorStore } from './tools/vector-search.ts'
import { analyzeExamWorkflow } from './workflows/analyze-exam.workflow.ts'
import { generateExamWorkflow } from './workflows/generate-exam.workflow.ts'
import { gradeAttemptWorkflow } from './workflows/grade-attempt.workflow.ts'
import { ingestExamWorkflow } from './workflows/ingest-exam.workflow.ts'
import { weaknessWorkflow } from './workflows/weakness.workflow.ts'

/**
 * 認証: KAKOMON_ADMIN_TOKEN が設定されていれば、Mastra 標準の /api/* (作問・分析ワークフロー) と
 * Studio、管理者ルートをそのトークンで保護する。受験者向け /kakomon/* は requiresAuth: false で公開のまま。
 * 未設定 (ローカル開発) ではすべて無認証。
 */
const auth = config.adminToken
  ? new SimpleAuth<{ id: string; name: string; role: 'admin' }>({
      tokens: { [config.adminToken]: { id: 'admin', name: 'Administrator', role: 'admin' } },
    })
  : undefined

/**
 * Vercel にデプロイするときだけ VercelDeployer を有効にする (VERCEL=1 はビルド時に Vercel が設定する)。
 * studio: true で管理者用の Studio も同じデプロイに同梱する (auth で保護される)。
 */
const deployer = process.env.VERCEL ? new VercelDeployer({ studio: true, maxDuration: 300 }) : undefined

if (config.ephemeralDb) {
  console.warn(
    '[kakomon] サーバレス環境でローカルファイル DB にフォールバックしています。データは永続化されません。KAKOMON_DB_URL に Turso (libsql://...) と TURSO_AUTH_TOKEN を設定してください。',
  )
}

export const mastra = new Mastra({
  agents: { extractorAgent, analystAgent, generatorAgent, reviewerAgent, graderAgent, coachAgent },
  workflows: { ingestExamWorkflow, analyzeExamWorkflow, generateExamWorkflow, gradeAttemptWorkflow, weaknessWorkflow },
  // ワークフローの suspend/resume 状態・トレースを保持する (ドメイン DB と同じ DB)
  storage: new LibSQLStore({ id: 'kakomon-storage', url: config.dbUrl, authToken: config.dbAuthToken }),
  vectors: { kakomonVector: vectorStore },
  deployer,
  server: {
    auth,
    apiRoutes,
  },
})
