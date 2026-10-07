import { z } from 'zod'

/**
 * 出題要件定義 (ExamSpec)。
 * 過去問の分析結果を「別の LLM が作問できる仕様書」として固定したもの。
 * 管理者が確認・編集した上で予想問題生成の入力になる。
 */

export const domainWeightSchema = z.object({
  domain: z.string().describe('出題分野 (大分類)'),
  topics: z
    .array(
      z.object({
        topic: z.string(),
        /** この分野内での出題比率 (0-1) */
        share: z.number().min(0).max(1),
        /** 頻出キーワード */
        keywords: z.array(z.string()).default([]),
        /** 過去に出た設問番号の参照 (examId:number) */
        pastReferences: z.array(z.string()).default([]),
        trend: z.enum(['増加', '横ばい', '減少', '新規']).default('横ばい'),
      }),
    )
    .min(1),
  /** 試験全体に占める出題比率 (0-1) */
  share: z.number().min(0).max(1),
  /** 想定出題数 */
  expectedCount: z.number().int().min(0),
})

export const questionPatternSchema = z.object({
  questionType: z.string().describe('設問の型 (定義・用語 / 正誤判定 / 計算 など)'),
  share: z.number().min(0).max(1).describe('出題比率'),
  /** 典型的な問い方のテンプレ (例: "〜として最も適切なものはどれか") */
  stemTemplates: z.array(z.string()).default([]),
  /** 誤答選択肢の作り方 */
  distractorTechniques: z.array(z.string()).default([]),
  /** 過去問の例 (examId:number) */
  examples: z.array(z.string()).default([]),
})

export const examSpecSchema = z.object({
  specVersion: z.literal(1).default(1),
  title: z.string().describe('対象試験名'),
  summary: z.string().describe('試験の性格・傾向の総括 (管理者向け要約)'),
  /** 形式要件 */
  format: z.object({
    questionCount: z.number().int().min(1),
    choicesPerQuestion: z.number().int().min(2).max(10),
    timeLimitMinutes: z.number().int().optional(),
    /** 正解数 (単一/複数) */
    answerMode: z.enum(['single', 'multiple']).default('single'),
    stemStyle: z.string().describe('問題文の文体・敬体/常体・長さの目安'),
    choiceStyle: z.string().describe('選択肢の文体・長さ・並び順の規則'),
    numberingNotes: z.string().optional(),
  }),
  /** 分野構成と比率 */
  domains: z.array(domainWeightSchema).min(1),
  /** 作問方法 (問い方パターン) */
  patterns: z.array(questionPatternSchema).min(1),
  /** 難易度分布: 1〜5 の比率 */
  difficultyDistribution: z
    .object({ 1: z.number(), 2: z.number(), 3: z.number(), 4: z.number(), 5: z.number() })
    .describe('難易度ごとの比率 (合計 1)'),
  cognitiveDistribution: z
    .object({ 知識: z.number(), 理解: z.number(), 応用: z.number(), 分析: z.number() })
    .describe('認知レベルごとの比率 (合計 1)'),
  /** 作問ルール (必須/禁止) */
  rules: z.object({
    must: z.array(z.string()).describe('必ず守る作問ルール'),
    mustNot: z.array(z.string()).describe('禁止事項 (過去問の丸写し, 曖昧な正解 など)'),
    styleGuide: z.array(z.string()).default([]).describe('表記ルール (用語, 単位, 敬体など)'),
  }),
  /** 次回の予想 (重点分野・新規出題の可能性) */
  forecast: z.array(
    z.object({
      topic: z.string(),
      reason: z.string(),
      priority: z.enum(['high', 'medium', 'low']),
    }),
  ),
  /** 分析に使った過去問 */
  sourceExamIds: z.array(z.string()),
})
export type ExamSpec = z.infer<typeof examSpecSchema>

/** 生成した予想問題に対するレビュー結果 */
export const reviewResultSchema = z.object({
  overallScore: z.number().min(0).max(100).describe('要件定義への適合度 0-100'),
  approved: z.boolean().describe('管理者レビューに回して良い品質か'),
  issues: z.array(
    z.object({
      questionNumber: z.number().int().optional(),
      severity: z.enum(['blocker', 'major', 'minor']),
      category: z.enum(['要件逸脱', '正解の曖昧さ', '過去問との重複', '誤答選択肢の弱さ', '表記', '事実誤認', 'その他']),
      message: z.string(),
      suggestion: z.string().optional(),
    }),
  ),
  coverage: z.object({
    domainCoverage: z.string().describe('分野比率が要件と一致しているかの評価'),
    difficultyCoverage: z.string(),
    patternCoverage: z.string(),
  }),
})
export type ReviewResult = z.infer<typeof reviewResultSchema>
