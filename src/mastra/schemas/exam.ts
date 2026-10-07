import { z } from 'zod'

/**
 * 過去問 (および予想問題) の構造化スキーマ。
 * PDF から抽出した結果も、生成した予想問題も同じ形で保持する。
 */

export const choiceSchema = z.object({
  /** 選択肢ラベル。元の表記をそのまま (例: "1", "ア", "①", "A") */
  label: z.string().describe('選択肢ラベル。原本の表記のまま'),
  text: z.string().describe('選択肢本文'),
  /** 正解/不正解の理由。採点時の解説の根拠になる */
  rationale: z.string().optional().describe('この選択肢が正解/不正解である理由'),
})
export type Choice = z.infer<typeof choiceSchema>

export const questionSchema = z.object({
  number: z.number().int().describe('大問/設問番号 (通し)'),
  /** 複数の設問が同じ資料文を共有する場合、資料文を passage に入れる */
  passage: z.string().optional().describe('設問が参照する資料・事例文 (共有される場合)'),
  stem: z.string().describe('問題文 (設問本体)'),
  choices: z.array(choiceSchema).min(2),
  correctLabel: z.string().optional().describe('正解の選択肢ラベル (解答が判明している場合)'),
  /** 出題分野 (大分類 > 小分類)。要件定義の分野体系に合わせる */
  domain: z.string().describe('出題分野 (大分類)'),
  topic: z.string().describe('出題トピック (小分類)'),
  /** 問われ方のパターン。作問方法の分析に使う */
  questionType: z
    .enum(['定義・用語', '正誤判定', '計算', '事例適用', '手順・順序', '比較・分類', 'その他'])
    .describe('設問の型'),
  difficulty: z.number().int().min(1).max(5).describe('難易度 1(易)〜5(難)'),
  cognitiveLevel: z.enum(['知識', '理解', '応用', '分析']).describe('求められる認知レベル'),
  /** 作問テクニック。誤答選択肢の作り方など */
  distractorTechniques: z
    .array(z.string())
    .default([])
    .describe('誤答選択肢の作り方 (例: 用語入替, 数値改変, 部分的真, 否定語)'),
  keywords: z.array(z.string()).default([]).describe('キーワード'),
  explanation: z.string().optional().describe('解説 (原本にあれば)'),
})
export type Question = z.infer<typeof questionSchema>

/**
 * 原本の見た目を再現するためのレイアウト情報。
 * 列挙型を中心にして、レンダラが決定的に HTML を組めるようにする。
 */
export const layoutProfileSchema = z.object({
  paperSize: z.enum(['A4', 'B5', 'B4', 'Letter']).default('A4'),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  columns: z.number().int().min(1).max(3).default(1).describe('段組み数'),
  headerText: z.string().optional().describe('各ページ上部の見出し (試験名・年度など)'),
  footerText: z.string().optional().describe('ページ下部の注記'),
  coverNotes: z.array(z.string()).default([]).describe('表紙・冒頭の注意事項'),
  questionNumberFormat: z
    .string()
    .default('問{n}')
    .describe('設問番号の書式。{n} を番号に置換 (例: "問{n}", "第{n}問", "{n}.")'),
  choiceLabelStyle: z
    .enum(['digit', 'circled-digit', 'katakana', 'hiragana', 'alpha-upper', 'alpha-lower', 'paren-digit'])
    .default('digit')
    .describe('選択肢ラベルの様式'),
  choiceLayout: z.enum(['vertical', 'inline']).default('vertical').describe('選択肢の並び'),
  fontFamily: z.enum(['mincho', 'gothic']).default('mincho').describe('本文フォント系統'),
  fontSizePt: z.number().min(8).max(14).default(10.5),
  writingMode: z.enum(['horizontal', 'vertical']).default('horizontal').describe('横書き/縦書き'),
  hasAnswerSheet: z.boolean().default(false).describe('別紙マークシート/解答用紙の有無'),
  styleNotes: z.string().optional().describe('その他の見た目の特徴 (自由記述)'),
})
export type LayoutProfile = z.infer<typeof layoutProfileSchema>

/** PDF 抽出の出力 */
export const extractedExamSchema = z.object({
  title: z.string().describe('試験名'),
  year: z.number().int().optional().describe('実施年度'),
  session: z.string().optional().describe('回次 (例: 第1回, 前期)'),
  timeLimitMinutes: z.number().int().optional(),
  instructions: z.array(z.string()).default([]).describe('受験上の注意・指示文'),
  questions: z.array(questionSchema).min(1),
  layout: layoutProfileSchema,
  /** 抽出時に気づいた点 (判読不能な箇所など) */
  extractionNotes: z.array(z.string()).default([]),
})
export type ExtractedExam = z.infer<typeof extractedExamSchema>

/** 回答者に見せる形 (正解・解説・根拠を落とした問題) */
export const publicQuestionSchema = questionSchema
  .pick({ number: true, passage: true, stem: true, domain: true, topic: true })
  .extend({
    choices: z.array(choiceSchema.pick({ label: true, text: true })),
  })
export type PublicQuestion = z.infer<typeof publicQuestionSchema>

export function toPublicQuestion(q: Question): PublicQuestion {
  return {
    number: q.number,
    passage: q.passage,
    stem: q.stem,
    domain: q.domain,
    topic: q.topic,
    choices: q.choices.map(c => ({ label: c.label, text: c.text })),
  }
}
