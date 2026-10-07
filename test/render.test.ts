import { describe, expect, it } from 'vitest'
import { formatChoiceLabel, formatQuestionNumber, renderExamHtml } from '../src/mastra/render/html.ts'
import { makeExam } from './fixtures.ts'

describe('renderExamHtml', () => {
  it('applies the layout profile (columns, numbering, label style) and hides answers by default', () => {
    const html = renderExamHtml(makeExam())
    expect(html).toContain('column-count: 2')
    expect(html).toContain('size: 210mm 297mm')
    expect(html).toContain('問1')
    expect(html).toContain('<span class="label">①</span>')
    expect(html).not.toContain('正解:')
    expect(html).not.toContain('1 は正しい')
  })

  it('includes answers and rationales when requested and escapes HTML', () => {
    const exam = makeExam()
    exam.questions[0]!.stem = '<b>危険</b> & 記号'
    const html = renderExamHtml(exam, { withAnswers: true })
    expect(html).toContain('正解: ①')
    expect(html).toContain('1 は正しい')
    expect(html).toContain('&lt;b&gt;危険&lt;/b&gt; &amp; 記号')
  })

  it('formats labels per style', () => {
    expect(formatChoiceLabel('3', 'katakana')).toBe('ウ')
    expect(formatChoiceLabel('2', 'alpha-upper')).toBe('B')
    expect(formatChoiceLabel('4', 'paren-digit')).toBe('(4)')
    expect(formatChoiceLabel('ア', 'circled-digit')).toBe('ア') // 非数値はそのまま
    expect(formatQuestionNumber(7, '第{n}問')).toBe('第7問')
  })
})
