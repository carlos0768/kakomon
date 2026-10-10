import type { ExamSpec } from '../schemas/spec.ts'

const pct = (n: number) => `${Math.round(n * 100)}%`

/** 出題要件定義を管理者が読める Markdown に整形する */
export function specToMarkdown(spec: ExamSpec, specId?: string): string {
  const lines: string[] = []
  lines.push(`# 出題要件定義: ${spec.title}`)
  if (specId) lines.push(`\n- specId: \`${specId}\``)
  lines.push(`- 分析対象: ${spec.sourceExamIds.map(id => `\`${id}\``).join(', ')}`)
  lines.push(`\n## 総括\n\n${spec.summary}`)

  lines.push(`\n## 形式要件\n`)
  lines.push(`| 項目 | 値 |\n|---|---|`)
  lines.push(`| 設問数 | ${spec.format.questionCount} |`)
  lines.push(`| 選択肢数 | ${spec.format.choicesPerQuestion} |`)
  lines.push(`| 解答形式 | ${spec.format.answerMode === 'single' ? '単一正解' : '複数正解'} |`)
  if (spec.format.timeLimitMinutes) lines.push(`| 制限時間 | ${spec.format.timeLimitMinutes} 分 |`)
  lines.push(`| 問題文の文体 | ${spec.format.stemStyle} |`)
  lines.push(`| 選択肢の文体 | ${spec.format.choiceStyle} |`)
  if (spec.format.numberingNotes) lines.push(`| 番号付け | ${spec.format.numberingNotes} |`)

  if (spec.format.sections.length) {
    lines.push(`\n## 大問構成 (大問の数・小問数は厳守)\n`)
    lines.push(`| 大問 | 小問数 | 指示文 | 分野 | 共通資料文 | 特徴 |\n|---|---|---|---|---|---|`)
    for (const s of [...spec.format.sections].sort((a, b) => a.number - b.number)) {
      lines.push(
        `| ${s.title || `第${s.number}問`} | ${s.questionCount} | ${s.instruction ?? ''} | ${s.domains.join(', ')} | ${s.sharedPassage ? 'あり' : ''} | ${s.notes ?? ''} |`,
      )
    }
  }

  lines.push(`\n## 分野構成と出題比率\n`)
  for (const d of spec.domains) {
    lines.push(`### ${d.domain} — ${pct(d.share)} (約 ${d.expectedCount} 問)\n`)
    lines.push(`| トピック | 分野内比率 | 傾向 | キーワード | 過去問参照 |\n|---|---|---|---|---|`)
    for (const t of d.topics) {
      lines.push(`| ${t.topic} | ${pct(t.share)} | ${t.trend} | ${t.keywords.join(', ')} | ${t.pastReferences.join(', ')} |`)
    }
    lines.push('')
  }

  lines.push(`## 作問方法 (問い方パターン)\n`)
  for (const p of spec.patterns) {
    lines.push(`### ${p.questionType} — ${pct(p.share)}`)
    if (p.stemTemplates.length) lines.push(`- 典型的な問い方: ${p.stemTemplates.map(s => `「${s}」`).join(' / ')}`)
    if (p.distractorTechniques.length) lines.push(`- 誤答選択肢の作り方: ${p.distractorTechniques.join(', ')}`)
    if (p.examples.length) lines.push(`- 例: ${p.examples.join(', ')}`)
    lines.push('')
  }

  lines.push(`## 難易度・認知レベル分布\n`)
  lines.push(`| 難易度 | 1 | 2 | 3 | 4 | 5 |\n|---|---|---|---|---|---|`)
  const d = spec.difficultyDistribution
  lines.push(`| 比率 | ${pct(d[1])} | ${pct(d[2])} | ${pct(d[3])} | ${pct(d[4])} | ${pct(d[5])} |`)
  const c = spec.cognitiveDistribution
  lines.push(`\n| 知識 | 理解 | 応用 | 分析 |\n|---|---|---|---|\n| ${pct(c.知識)} | ${pct(c.理解)} | ${pct(c.応用)} | ${pct(c.分析)} |`)

  lines.push(`\n## 作問ルール\n`)
  lines.push(`### 必須`)
  for (const r of spec.rules.must) lines.push(`- ${r}`)
  lines.push(`\n### 禁止`)
  for (const r of spec.rules.mustNot) lines.push(`- ${r}`)
  if (spec.rules.styleGuide.length) {
    lines.push(`\n### 表記ルール`)
    for (const r of spec.rules.styleGuide) lines.push(`- ${r}`)
  }

  lines.push(`\n## 次回予想 (重点トピック)\n`)
  lines.push(`| 優先度 | トピック | 理由 |\n|---|---|---|`)
  for (const f of spec.forecast) lines.push(`| ${f.priority} | ${f.topic} | ${f.reason} |`)
  if (spec.sources.length) {
    lines.push(`\n## 参照した出典 (ネット検索)\n`)
    for (const src of spec.sources) lines.push(`- [${src.title}](${src.url})${src.note ? ` — ${src.note}` : ''}`)
  }
  lines.push('')
  return lines.join('\n')
}
