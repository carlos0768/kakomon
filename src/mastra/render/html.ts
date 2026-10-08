import { resolvePassage, type ExtractedExam, type LayoutProfile, type Question } from '../schemas/exam.ts'

/**
 * レイアウトプロファイルに従って、過去問の見た目を模した HTML を生成する。
 * 写真 PDF から抽出した layout (段組み・番号書式・ラベル様式・フォント系統) を反映する。
 */

const PAPER: Record<LayoutProfile['paperSize'], string> = {
  A4: '210mm 297mm',
  B5: '182mm 257mm',
  B4: '257mm 364mm',
  Letter: '8.5in 11in',
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩'
const KATAKANA = 'アイウエオカキクケコ'
const HIRAGANA = 'あいうえおかきくけこ'

/** 選択肢の表示ラベル。原本のラベルが数字なら様式に合わせて変換し、それ以外は原本のまま */
export function formatChoiceLabel(label: string, style: LayoutProfile['choiceLabelStyle']): string {
  const n = Number.parseInt(label, 10)
  if (!Number.isInteger(n) || n < 1 || n > 10) return label
  switch (style) {
    case 'circled-digit':
      return CIRCLED[n - 1] ?? label
    case 'katakana':
      return KATAKANA[n - 1] ?? label
    case 'hiragana':
      return HIRAGANA[n - 1] ?? label
    case 'alpha-upper':
      return String.fromCharCode(64 + n)
    case 'alpha-lower':
      return String.fromCharCode(96 + n)
    case 'paren-digit':
      return `(${n})`
    default:
      return String(n)
  }
}

export function formatQuestionNumber(n: number, fmt: string): string {
  return (fmt || '問{n}').replace('{n}', String(n))
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function nl2br(s: string): string {
  return escapeHtml(s).replace(/\n/g, '<br>')
}

export interface RenderOptions {
  /** 正解・解説を含める (管理者用/解答編) */
  withAnswers?: boolean
}

export function renderExamHtml(exam: ExtractedExam, opts: RenderOptions = {}): string {
  const L = exam.layout
  const font =
    L.fontFamily === 'gothic'
      ? '"Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", Meiryo, sans-serif'
      : '"Hiragino Mincho ProN", "Noto Serif JP", "Yu Mincho", "MS Mincho", serif'
  const pageSize = `${PAPER[L.paperSize]}${L.orientation === 'landscape' ? ' landscape' : ''}`
  const vertical = L.writingMode === 'vertical'

  // 共有資料文は、それを参照する最初の設問の前に 1 回だけ印字する (原本と同じ並び)
  let prevPassage: string | undefined
  const questionsHtml = exam.questions
    .map(q => {
      const passage = resolvePassage(q, exam.passages)
      const showPassage = Boolean(passage) && passage !== prevPassage
      prevPassage = passage
      const shared = q.passageId ? exam.passages.find(p => p.id === q.passageId) : undefined
      return renderQuestion(q, L, opts, showPassage ? { text: passage!, title: shared?.title } : undefined)
    })
    .join('\n')
  const header = L.headerText ?? [exam.title, exam.year ? `${exam.year}年度` : '', exam.session ?? ''].filter(Boolean).join('　')

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${escapeHtml(exam.title)}</title>
<style>
  @page { size: ${pageSize}; margin: 18mm 16mm; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ${font};
    font-size: ${L.fontSizePt}pt;
    line-height: 1.7;
    color: #111;
    ${vertical ? 'writing-mode: vertical-rl;' : ''}
  }
  .sheet { max-width: ${L.orientation === 'landscape' ? '297mm' : '210mm'}; margin: 0 auto; padding: 18mm 16mm; background: #fff; }
  @media print { .sheet { padding: 0; max-width: none; } }
  header.exam-header { text-align: center; border-bottom: 1px solid #000; padding-bottom: 4pt; margin-bottom: 10pt; font-weight: bold; }
  .notes { border: 1px solid #000; padding: 6pt 10pt; margin-bottom: 12pt; }
  .notes ol { margin: 0; padding-${vertical ? 'top' : 'left'}: 1.5em; }
  .questions { column-count: ${L.columns}; column-gap: 8mm; ${L.columns > 1 ? 'column-rule: 1px solid #999;' : ''} }
  .q { break-inside: avoid; margin-bottom: 12pt; }
  .q .num { font-weight: bold; margin-${vertical ? 'bottom' : 'right'}: 0.5em; }
  .passage { border-left: 2px solid #666; padding-left: 8pt; margin: 6pt 0 8pt; white-space: pre-wrap; break-inside: avoid-column; }
  .passage-title { font-weight: bold; margin-bottom: 3pt; }
  .choices { margin: 4pt 0 0; padding: 0; list-style: none; }
  .choices.inline li { display: inline-block; margin-right: 1.5em; }
  .choices li { margin: 2pt 0; }
  .choices .label { display: inline-block; min-width: 1.6em; }
  .answer { margin-top: 4pt; padding: 4pt 6pt; background: #f3f3f3; font-size: 90%; }
  .answer .r { display: block; }
  footer.exam-footer { margin-top: 14pt; text-align: center; font-size: 85%; color: #333; }
  ${L.styleNotes ? `/* styleNotes: ${escapeHtml(L.styleNotes)} */` : ''}
</style>
</head>
<body>
<div class="sheet">
<header class="exam-header">${escapeHtml(header)}</header>
${
  exam.instructions.length || L.coverNotes.length
    ? `<section class="notes"><ol>${[...L.coverNotes, ...exam.instructions].map(n => `<li>${nl2br(n)}</li>`).join('')}</ol></section>`
    : ''
}
<main class="questions">
${questionsHtml}
</main>
${L.footerText ? `<footer class="exam-footer">${escapeHtml(L.footerText)}</footer>` : ''}
</div>
</body>
</html>`
}

function renderQuestion(q: Question, L: LayoutProfile, opts: RenderOptions, passage?: { text: string; title?: string }): string {
  const num = formatQuestionNumber(q.number, L.questionNumberFormat)
  const choices = q.choices
    .map(
      c =>
        `<li><span class="label">${escapeHtml(formatChoiceLabel(c.label, L.choiceLabelStyle))}</span> ${nl2br(c.text)}</li>`,
    )
    .join('')
  const answer =
    opts.withAnswers && q.correctLabel
      ? `<div class="answer"><strong>正解: ${escapeHtml(formatChoiceLabel(q.correctLabel, L.choiceLabelStyle))}</strong>${q.choices
          .filter(c => c.rationale)
          .map(c => `<span class="r">${escapeHtml(formatChoiceLabel(c.label, L.choiceLabelStyle))}: ${nl2br(c.rationale!)}</span>`)
          .join('')}</div>`
      : ''
  const passageHtml = passage
    ? `<section class="passage">${passage.title ? `<div class="passage-title">${escapeHtml(passage.title)}</div>` : ''}${nl2br(passage.text)}</section>\n  `
    : ''
  return `${passageHtml}<article class="q" id="q${q.number}">
  <div><span class="num">${escapeHtml(num)}</span>${nl2br(q.stem)}</div>
  <ul class="choices ${L.choiceLayout}">${choices}</ul>
  ${answer}
</article>`
}
