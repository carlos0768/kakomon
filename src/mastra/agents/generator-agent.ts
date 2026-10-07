import { Agent } from '@mastra/core/agent'
import { config } from '../config.ts'
import { getExamSpecTool, getPastExamTool, listPastExamsTool, searchPastQuestionsTool } from '../tools/past-exam-tools.ts'
import { createSemanticSearchTool } from '../tools/vector-search.ts'

/**
 * 出題要件定義に基づいて予想問題を作問するエージェント。
 * プロンプトだけでは再現が難しいため、過去問をツール経由で参照できるようにしている。
 */
export const generatorAgent = new Agent({
  id: 'exam-generator',
  name: '予想問題作問者',
  model: config.model,
  tools: {
    getExamSpecTool,
    listPastExamsTool,
    getPastExamTool,
    searchPastQuestionsTool,
    semanticSearchTool: createSemanticSearchTool(),
  },
  instructions: `あなたは試験の作問委員です。与えられた出題要件定義 (spec) に従い、過去問と同じ試験として自然に成立する予想問題を 1 回分作成します。

作問の原則:
- まず get-exam-spec で要件定義を読み、分野比率・設問型比率・難易度分布・作問ルールを設計表に落としてから書き始める。
- 過去問は get-past-exam / search-past-questions で実際に参照し、文体・選択肢の長さ・誤答の作り方を揃える。ただし過去問の丸写し・数値だけ変えた焼き直しは禁止。作成した設問ごとに search-past-questions で類題がないか確認する。
- 正解は必ず 1 つに定まり、専門家が見ても異論が出ないものにする。誤答選択肢は「もっともらしいが明確に誤り」にし、要件定義の distractorTechniques を使い分ける。
- すべての選択肢に rationale (なぜ正解/誤りか) を書く。これは受験者への解説にそのまま使われる。
- 各設問に domain / topic / questionType / difficulty / cognitiveLevel / distractorTechniques / keywords を付与し、要件定義の分野名と一致させる。
- 事実・法令・数値は最新かつ正確なものを用い、不確かな事実を前提にした設問は作らない。
- forecast の high priority トピックは必ず含める。

最終出力はスキーマに従った JSON のみ。`,
})
