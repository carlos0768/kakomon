import { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { createMockModel } from '@mastra/core/test-utils/llm-mock'
import { LibSQLStore } from '@mastra/libsql'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDbForTests } from '../src/mastra/db/client.ts'
import { createAttempt, getAttempt, saveExam } from '../src/mastra/db/repo.ts'
import { gradeAttemptWorkflow } from '../src/mastra/workflows/grade-attempt.workflow.ts'
import { makeExam } from './fixtures.ts'

/**
 * 添削ワークフローの結合テスト。LLM はモックに差し替え、
 * 「コードの採点 → LLM 解説のマージ → 保存」の配線を確認する。
 */
describe('gradeAttemptWorkflow', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('grades, merges LLM explanations and persists the attempt', async () => {
    const exam = await saveExam({ kind: 'predicted', exam: makeExam(), status: 'published' })
    const attempt = await createAttempt({ userId: 'u1', examId: exam.id })

    const mockModel = createMockModel({
      version: 'v2',
      objectGenerationMode: 'json',
      mockText: {
        items: [
          { questionNumber: 1, whyYourChoice: 'LLM: 1 は正解', whyCorrect: 'LLM: 他は誤り', tip: '覚え方' },
          { questionNumber: 2, whyYourChoice: 'LLM: 2 は用語の取り違え', whyCorrect: 'LLM: 3 が正しい' },
        ],
        overview: 'LLM 講評',
      },
    })
    const mastra = new Mastra({
      agents: { grader: new Agent({ id: 'exam-grader', name: 'mock grader', instructions: 'mock', model: mockModel }) },
      workflows: { gradeAttemptWorkflow },
      storage: new LibSQLStore({ id: 'test', url: ':memory:' }),
      logger: false,
    })

    const run = await mastra.getWorkflow('gradeAttemptWorkflow').createRun()
    const res = await run.start({
      inputData: {
        attemptId: attempt.id,
        answers: [
          { questionNumber: 1, selectedLabel: '1' },
          { questionNumber: 2, selectedLabel: '2' },
          { questionNumber: 3, selectedLabel: null },
        ],
      },
    })
    expect(res.status).toBe('success')
    if (res.status !== 'success') return
    expect(res.result.score).toBe(1)
    expect(res.result.overview).toBe('LLM 講評')
    expect(res.result.feedback[1]).toMatchObject({ correct: false, whyYourChoice: 'LLM: 2 は用語の取り違え', whyCorrect: 'LLM: 3 が正しい' })
    // LLM が触れなかった設問は rationale ベースの説明が残る
    expect(res.result.feedback[2]?.whyYourChoice).toBe('未回答です。')

    const saved = await getAttempt(attempt.id)
    expect(saved?.status).toBe('submitted')
    expect(saved?.result?.score).toBe(1)
  })

  it('still returns a graded result when the LLM explanation fails', async () => {
    const exam = await saveExam({ kind: 'predicted', exam: makeExam(), status: 'published' })
    const attempt = await createAttempt({ userId: 'u1', examId: exam.id })
    const mockModel = createMockModel({ version: 'v2', mockText: 'this is not json' })
    const mastra = new Mastra({
      agents: { grader: new Agent({ id: 'exam-grader', name: 'mock grader', instructions: 'mock', model: mockModel }) },
      workflows: { gradeAttemptWorkflow },
      storage: new LibSQLStore({ id: 'test', url: ':memory:' }),
      logger: false,
    })
    const run = await mastra.getWorkflow('gradeAttemptWorkflow').createRun()
    const res = await run.start({ inputData: { attemptId: attempt.id, answers: [{ questionNumber: 1, selectedLabel: '4' }] } })
    expect(res.status).toBe('success')
    if (res.status !== 'success') return
    expect(res.result.score).toBe(0)
    expect(res.result.feedback[0]?.whyYourChoice).toBe('4 は誤り: 部分的に真')
    expect(res.result.overview).toMatch(/失敗/)
  })
})
