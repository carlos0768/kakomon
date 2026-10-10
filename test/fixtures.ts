import type { ExtractedExam, Question } from '../src/mastra/schemas/exam.ts'
import type { ExamSpec } from '../src/mastra/schemas/spec.ts'

export function makeQuestion(over: Partial<Question> & { number: number }): Question {
  return {
    stem: `設問 ${over.number} の問題文`,
    choices: [
      { label: '1', text: '選択肢1', rationale: '1 は正しい' },
      { label: '2', text: '選択肢2', rationale: '2 は誤り: 用語の取り違え' },
      { label: '3', text: '選択肢3', rationale: '3 は誤り: 数値が違う' },
      { label: '4', text: '選択肢4', rationale: '4 は誤り: 部分的に真' },
    ],
    correctLabel: '1',
    domain: '法規',
    topic: '安全管理',
    questionType: '正誤判定',
    difficulty: 3,
    cognitiveLevel: '理解',
    distractorTechniques: ['用語入替'],
    keywords: ['安全'],
    ...over,
  }
}

export function makeExam(over: Partial<ExtractedExam> = {}): ExtractedExam {
  return {
    title: 'サンプル試験',
    year: 2024,
    session: '第1回',
    instructions: ['各問に最も適切なものを 1 つ選べ'],
    passages: [],
    sections: [],
    questions: [
      makeQuestion({ number: 1 }),
      makeQuestion({ number: 2, domain: '技術', topic: '計算', questionType: '計算', correctLabel: '3' }),
      makeQuestion({ number: 3, domain: '技術', topic: '構造', questionType: '定義・用語', correctLabel: '2' }),
    ],
    layout: {
      paperSize: 'A4',
      orientation: 'portrait',
      columns: 2,
      questionNumberFormat: '問{n}',
      choiceLabelStyle: 'circled-digit',
      choiceLayout: 'vertical',
      fontFamily: 'mincho',
      fontSizePt: 10.5,
      writingMode: 'horizontal',
      hasAnswerSheet: true,
      coverNotes: [],
    },
    extractionNotes: [],
    ...over,
  }
}

export function makeSpec(over: Partial<ExamSpec> = {}): ExamSpec {
  return {
    specVersion: 1,
    title: 'サンプル試験',
    summary: '法規と技術が半々',
    format: { questionCount: 3, choicesPerQuestion: 4, answerMode: 'single', stemStyle: '常体', choiceStyle: '短文', sections: [] },
    domains: [
      { domain: '法規', share: 0.4, expectedCount: 1, topics: [{ topic: '安全管理', share: 1, keywords: [], pastReferences: [], trend: '横ばい' }] },
      {
        domain: '技術',
        share: 0.6,
        expectedCount: 2,
        topics: [
          { topic: '計算', share: 0.5, keywords: [], pastReferences: [], trend: '増加' },
          { topic: '構造', share: 0.5, keywords: [], pastReferences: [], trend: '横ばい' },
        ],
      },
    ],
    patterns: [{ questionType: '正誤判定', share: 1, stemTemplates: [], distractorTechniques: [], examples: [] }],
    difficultyDistribution: { 1: 0.1, 2: 0.2, 3: 0.4, 4: 0.2, 5: 0.1 },
    cognitiveDistribution: { 知識: 0.4, 理解: 0.3, 応用: 0.2, 分析: 0.1 },
    rules: { must: ['正解は 1 つ'], mustNot: ['過去問の丸写し'], styleGuide: [] },
    forecast: [{ topic: '計算', reason: '増加傾向', priority: 'high' }],
    sourceExamIds: [],
    sources: [],
    ...over,
  }
}
