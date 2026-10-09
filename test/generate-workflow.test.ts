import { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { createMockModel } from '@mastra/core/test-utils/llm-mock'
import { LibSQLStore } from '@mastra/libsql'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetDbForTests } from '../src/mastra/db/client.ts'
import { listExams, saveExam, saveSpec } from '../src/mastra/db/repo.ts'
import { generateExamWorkflow } from '../src/mastra/workflows/generate-exam.workflow.ts'
import { makeExam, makeQuestion, makeSpec } from './fixtures.ts'

/**
 * 作問ワークフローの結合テスト。LLM はモックに差し替え、
 * 「バッチ分割 → マージ (番号振り直し・切り捨て) → 校閲 → 下書き保存 → 承認待ちで suspend」の配線を確認する。
 */
describe('generateExamWorkflow', () => {
  beforeEach(async () => {
    await resetDbForTests()
    process.env.KAKOMON_GENERATE_BATCH = '2'
    process.env.KAKOMON_CHROMIUM_PATH = '/nonexistent/chromium' // PDF 生成は飛ばす (HTML だけ出す)
  })

  it('generates in batches, merges with renumbering, reviews, saves a draft with passages and suspends for approval', async () => {
    const spec = await saveSpec({ spec: makeSpec({ format: { ...makeSpec().format, questionCount: 3 } }) })
    await saveExam({ kind: 'past', exam: makeExam(), status: 'published' })

    // 作問モックは毎回「資料文 1 つ + 設問 2 問」を返す (2 バッチ目は 1 問の予定なので 1 問切り捨てられる)
    const generatorModel = createMockModel({
      version: 'v2',
      objectGenerationMode: 'json',
      mockText: {
        passages: [{ id: 'P1-1', text: '共有の長文' }],
        questions: [makeQuestion({ number: 1, passageId: 'P1-1' }), makeQuestion({ number: 2, domain: '技術', topic: '計算' })],
        designNotes: '法規と技術を配分',
      },
    })
    const reviewerModel = createMockModel({
      version: 'v2',
      objectGenerationMode: 'json',
      mockText: {
        overallScore: 90,
        approved: true,
        issues: [],
        coverage: { domainCoverage: 'ok', difficultyCoverage: 'ok', patternCoverage: 'ok' },
      },
    })
    const mastra = new Mastra({
      agents: {
        generator: new Agent({ id: 'exam-generator', name: 'mock generator', instructions: 'mock', model: generatorModel }),
        reviewer: new Agent({ id: 'exam-reviewer', name: 'mock reviewer', instructions: 'mock', model: reviewerModel }),
      },
      workflows: { generateExamWorkflow },
      storage: new LibSQLStore({ id: 'test', url: ':memory:' }),
      logger: false,
    })

    const run = await mastra.getWorkflow('generateExamWorkflow').createRun()
    const res = await run.start({ inputData: { specId: spec.id, title: '予想問題 第1回', maxRevisions: 1 } })
    expect(res.status).toBe('suspended')

    const [draft] = await listExams({ kind: 'predicted' })
    expect(draft?.status).toBe('review')
    expect(draft?.exam.questions.map(q => q.number)).toEqual([1, 2, 3])
    expect(draft?.exam.questions[0]?.passageId).toBe('P1-1')
    expect(draft?.exam.passages).toEqual([{ id: 'P1-1', text: '共有の長文' }])
    expect(draft?.exam.extractionNotes).toContain('バッチ 2: 1 問多く出力されたため切り捨て')
    expect(draft?.exam.extractionNotes.some(n => n.includes('法規と技術を配分'))).toBe(true)
    expect(draft?.exam.instructions).toEqual(makeExam().instructions) // 注意書きは参照過去問から引き継ぐ
  })

  it('keeps the draft and suspends for approval even when the reviewer fails to return a result', async () => {
    const spec = await saveSpec({ spec: makeSpec({ format: { ...makeSpec().format, questionCount: 2 } }) })
    await saveExam({ kind: 'past', exam: makeExam(), status: 'published' })
    const generatorModel = createMockModel({
      version: 'v2',
      objectGenerationMode: 'json',
      mockText: { passages: [], questions: [makeQuestion({ number: 1 }), makeQuestion({ number: 2, domain: '技術', topic: '計算' })], designNotes: '' },
    })
    // 校閲モックは JSON ではない文字列を返す → 構造化出力が取れず失敗する
    const reviewerModel = createMockModel({ version: 'v2', mockText: 'ごめんなさい、今回は判定できません。' })
    const mastra = new Mastra({
      agents: {
        generator: new Agent({ id: 'exam-generator', name: 'mock generator', instructions: 'mock', model: generatorModel }),
        reviewer: new Agent({ id: 'exam-reviewer', name: 'mock reviewer', instructions: 'mock', model: reviewerModel }),
      },
      workflows: { generateExamWorkflow },
      storage: new LibSQLStore({ id: 'test', url: ':memory:' }),
      logger: false,
    })
    const run = await mastra.getWorkflow('generateExamWorkflow').createRun()
    const res = await run.start({ inputData: { specId: spec.id, title: '予想問題 第2回', maxRevisions: 1 } })
    expect(res.status).toBe('suspended')
    const [draft] = await listExams({ kind: 'predicted' })
    expect(draft?.status).toBe('review')
    expect(draft?.exam.questions).toHaveLength(2)
    expect(draft?.exam.extractionNotes.some(n => n.includes('校閲に失敗'))).toBe(true)
  })
})
