import { Mastra } from '@mastra/core'
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

export const mastra = new Mastra({
  agents: { extractorAgent, analystAgent, generatorAgent, reviewerAgent, graderAgent, coachAgent },
  workflows: { ingestExamWorkflow, analyzeExamWorkflow, generateExamWorkflow, gradeAttemptWorkflow, weaknessWorkflow },
  // ワークフローの suspend/resume 状態・トレースを保持する (ドメイン DB と同じファイル)
  storage: new LibSQLStore({ id: 'kakomon-storage', url: config.dbUrl }),
  vectors: { kakomonVector: vectorStore },
  server: {
    apiRoutes,
  },
})
