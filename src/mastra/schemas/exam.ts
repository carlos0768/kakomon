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

/** 複数の設問で共有される資料文 (長文読解の本文など)。設問側は passageId で参照する */
export const passageSchema = z.object({
  id: z.string().describe('資料文 ID (例: "P1")'),
  title: z.string().optional().describe('資料文の見出し (例: "第1問 次の英文を読んで")'),
  text: z.string().describe('資料文の本文 (原文のまま)'),
})
export type Passage = z.infer<typeof passageSchema>

/** 大問の見出しと指示文 (例: 「第1問 次の各問いに答えよ」)。設問側は section で所属を示す */
export const sectionSchema = z.object({
  number: z.number().int().min(1).describe('大問番号 (第1問 = 1)'),
  title: z.string().optional().describe('大問の見出し。原本の表記のまま (例: "第1問", "Ⅰ")'),
  instruction: z.string().optional().describe('大問の冒頭の指示文 (例: "次の各問いに答えよ。")'),
})
export type Section = z.infer<typeof sectionSchema>

export const questionSchema = z.object({
  number: z.number().int().describe('設問番号 (試験全体の通し番号)'),
  /** 大問のある試験で、この設問 (小問) が属する大問の番号。大問の区切りがない試験では省略 */
  section: z.number().int().min(1).optional().describe('所属する大問の番号 (sections の number)。大問の区切りがない試験は省略'),
  /** 共有資料文は passages に 1 回だけ置き、設問からは passageId で参照する (出力量を抑えるため) */
  passageId: z.string().optional().describe('参照する共有資料文の ID (passages の id)'),
  /** その設問だけが使う短い資料文。共有資料文は passageId を使う */
  passage: z.string().optional().describe('この設問専用の短い資料・事例文 (共有資料文は passageId で参照)'),
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
  /** 複数の設問で共有する資料文。長文は 1 回だけここに書く */
  passages: z.array(passageSchema).default([]).describe('複数の設問で共有する資料文 (1 回だけ記述)'),
  /** 大問の見出しと指示文。大問の区切りがない試験は空 */
  sections: z.array(sectionSchema).default([]).describe('大問の一覧 (見出し・指示文)。大問の区切りがない試験は空'),
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

/** 設問が参照する資料文 (専用の passage か、passages から passageId で引いたもの) */
export function resolvePassage(q: Pick<Question, 'passage' | 'passageId'>, passages: Passage[] = []): string | undefined {
  if (q.passage) return q.passage
  if (q.passageId) return passages.find(p => p.id === q.passageId)?.text
  return undefined
}

/** 設問ごとに資料文を展開した配列を返す (表示・採点・検索用)。共有資料文は連続する設問で重複する */
export function questionsWithPassages<T extends Pick<Question, 'passage' | 'passageId'>>(
  questions: T[],
  passages: Passage[] = [],
): Array<T & { passage?: string }> {
  return questions.map(q => ({ ...q, passage: resolvePassage(q, passages) }))
}

export function toPublicQuestion(q: Question, passages: Passage[] = []): PublicQuestion {
  return {
    number: q.number,
    passage: resolvePassage(q, passages),
    stem: q.stem,
    domain: q.domain,
    topic: q.topic,
    choices: q.choices.map(c => ({ label: c.label, text: c.text })),
  }
}
