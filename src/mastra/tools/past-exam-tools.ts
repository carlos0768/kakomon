import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { aggregateQuestions, getExam, getSpec, listExams, searchQuestions } from '../db/repo.ts'
import { questionSchema, passageSchema } from '../schemas/exam.ts'

/**
 * 作問 LLM が過去問に自由にアクセスするためのツール群。
 * プロンプトに過去問を全部貼るのではなく、必要な設問を自分で引けるようにする。
 */

export const listPastExamsTool = createTool({
  id: 'list-past-exams',
  description: '登録済みの過去問 (および公開済み予想問題) の一覧を返す。年度・回次・設問数が分かる。',
  inputSchema: z.object({
    kind: z.enum(['past', 'predicted', 'all']).default('past').describe('past=過去問のみ'),
  }),
  outputSchema: z.object({
    exams: z.array(
      z.object({
        examId: z.string(),
        kind: z.string(),
        title: z.string(),
        year: z.number().optional(),
        session: z.string().optional(),
        questionCount: z.number(),
        domains: z.array(z.string()),
      }),
    ),
  }),
  execute: async ({ kind }) => {
    const exams = await listExams(kind === 'all' ? {} : { kind })
    return {
      exams: exams.map(e => ({
        examId: e.id,
        kind: e.kind,
        title: e.title,
        year: e.year,
        session: e.session,
        questionCount: e.exam.questions.length,
        domains: [...new Set(e.exam.questions.map(q => q.domain))],
      })),
    }
  },
})

export const getPastExamTool = createTool({
  id: 'get-past-exam',
  description:
    '過去問 1 回分の全設問 (問題文・選択肢・正解・分野・難易度・作問テクニック) を返す。量が多いので必要な回だけ呼ぶこと。',
  inputSchema: z.object({
    examId: z.string(),
    /** 省略時は全設問 */
    numbers: z.array(z.number().int()).optional().describe('取得したい設問番号 (省略で全件)'),
  }),
  outputSchema: z.object({
    examId: z.string(),
    title: z.string(),
    year: z.number().optional(),
    instructions: z.array(z.string()),
    passages: z.array(passageSchema).describe('複数の設問で共有される資料文。設問の passageId が参照する'),
    questions: z.array(questionSchema),
  }),
  execute: async ({ examId, numbers }) => {
    const rec = await getExam(examId)
    if (!rec) throw new Error(`exam not found: ${examId}`)
    const set = numbers?.length ? new Set(numbers) : undefined
    return {
      examId: rec.id,
      title: rec.title,
      year: rec.year,
      instructions: rec.exam.instructions,
      passages: rec.exam.passages,
      questions: rec.exam.questions.filter(q => !set || set.has(q.number)),
    }
  },
})

export const searchPastQuestionsTool = createTool({
  id: 'search-past-questions',
  description:
    '過去問の設問をキーワード・分野・トピック・設問型で検索する。似た問題がすでに出ていないかの確認や、特定分野の出題例を集めるのに使う。',
  inputSchema: z.object({
    keyword: z.string().optional().describe('空白区切りで AND 検索'),
    domain: z.string().optional(),
    topic: z.string().optional(),
    questionType: z.string().optional(),
    kind: z.enum(['past', 'predicted']).optional().describe('省略時は両方'),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  outputSchema: z.object({
    hits: z.array(
      z.object({
        examId: z.string(),
        examTitle: z.string(),
        year: z.number().optional(),
        question: questionSchema,
      }),
    ),
  }),
  execute: async input => {
    const hits = await searchQuestions(input)
    return { hits }
  },
})

export const getQuestionStatsTool = createTool({
  id: 'get-question-stats',
  description: '過去問全体の分野×トピック×設問型×難易度ごとの出題数を返す (定量的な傾向分析用)。',
  inputSchema: z.object({
    examIds: z.array(z.string()).optional().describe('省略で過去問すべて'),
  }),
  outputSchema: z.object({
    rows: z.array(
      z.object({
        examId: z.string(),
        year: z.number().optional(),
        domain: z.string(),
        topic: z.string(),
        questionType: z.string(),
        difficulty: z.number(),
        cognitiveLevel: z.string(),
        count: z.number(),
      }),
    ),
  }),
  execute: async ({ examIds }) => ({ rows: await aggregateQuestions(examIds) }),
})

export const getExamSpecTool = createTool({
  id: 'get-exam-spec',
  description: '出題要件定義 (分野比率・作問ルール・難易度分布など) を取得する。',
  inputSchema: z.object({ specId: z.string() }),
  outputSchema: z.object({ specId: z.string(), status: z.string(), spec: z.unknown() }),
  execute: async ({ specId }) => {
    const rec = await getSpec(specId)
    if (!rec) throw new Error(`spec not found: ${specId}`)
    return { specId: rec.id, status: rec.status, spec: rec.spec }
  },
})

export const pastExamTools = {
  listPastExamsTool,
  getPastExamTool,
  searchPastQuestionsTool,
  getQuestionStatsTool,
  getExamSpecTool,
}
