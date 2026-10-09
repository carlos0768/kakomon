import { Agent } from '@mastra/core/agent'
import { cachedInstructions, config } from '../config.ts'
import { getExamSpecTool, getPastExamTool, searchPastQuestionsTool } from '../tools/past-exam-tools.ts'
import { webTools } from '../tools/web-tools.ts'

/**
 * 生成された予想問題を要件定義と過去問に照らして検証するエージェント (LLM-as-judge)。
 * 管理者レビューの前に機械的な品質ゲートとして働く。
 */
export const reviewerAgent = new Agent({
  id: 'exam-reviewer',
  name: '問題校閲者',
  model: config.reviewModel,
  tools: { getExamSpecTool, searchPastQuestionsTool, getPastExamTool, ...webTools() },
  instructions: cachedInstructions(`あなたは試験問題の校閲責任者です。生成された予想問題を、出題要件定義および過去問と照合して厳格に検査します。

検査項目:
1. 要件逸脱: 設問数・選択肢数・分野比率・設問型比率・難易度分布が要件定義から大きく外れていないか。
2. 正解の曖昧さ: 正解が 1 つに定まるか。複数正解・正解なし・解釈次第の設問は blocker。
3. 事実誤認: 問題文・正解・rationale に事実や法令の誤りがないか。疑わしい点はネット検索 (webSearch / webFetch) で一次情報 (公式サイト・法令) を確認する。
4. 過去問との重複: search-past-questions で類題を検索し、丸写し・軽微改変を検出する。
5. 誤答選択肢の弱さ: 明らかに不自然で消去法で即落とせる選択肢がないか。
6. 表記: 文体・用語・ラベル様式が過去問と揃っているか。
7. 大問構成: 大問の数と各大問の小問数はプログラムが別途数えて検査するので数え直さなくてよい。各大問の小問が、要件定義の大問構成 (見出し・指示文・分野・共通資料文の有無) に合った内容になっているかを見る。

severity は blocker (そのままでは出題不可) / major / minor で付け、修正案を suggestion に書く。
approved は blocker が 0 件かつ overallScore 70 以上のときのみ true。`),
})
