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

  it('prints a shared passage once before the first question that references it', () => {
    const exam = makeExam({ passages: [{ id: 'P1', title: '次の英文を読んで答えよ', text: 'Long shared passage text.' }] })
    exam.questions[0]!.passageId = 'P1'
    exam.questions[1]!.passageId = 'P1'
    exam.questions[2]!.passage = '問3 だけの短い資料'
    const html = renderExamHtml(exam)
    expect(html.split('Long shared passage text.').length - 1).toBe(1)
    expect(html).toContain('次の英文を読んで答えよ')
    expect(html.indexOf('Long shared passage text.')).toBeLessThan(html.indexOf('id="q1"'))
    expect(html).toContain('問3 だけの短い資料')
  })

  it('prints each section heading and instruction once before its first question', () => {
    const exam = makeExam({ sections: [{ number: 1, title: '第1問', instruction: '次の各問いに答えよ。' }, { number: 2, title: '第2問' }] })
    exam.questions[0]!.section = 1
    exam.questions[1]!.section = 1
    exam.questions[2]!.section = 2
    const html = renderExamHtml(exam)
    expect(html.split('class="section-head"').length - 1).toBe(2)
    expect(html.indexOf('次の各問いに答えよ。')).toBeLessThan(html.indexOf('id="q1"'))
    expect(html.indexOf('id="q2"')).toBeLessThan(html.indexOf('id="s2"'))
    expect(html.indexOf('id="s2"')).toBeLessThan(html.indexOf('id="q3"'))
  })

  it('formats labels per style', () => {
    expect(formatChoiceLabel('3', 'katakana')).toBe('ウ')
    expect(formatChoiceLabel('2', 'alpha-upper')).toBe('B')
    expect(formatChoiceLabel('4', 'paren-digit')).toBe('(4)')
    expect(formatChoiceLabel('ア', 'circled-digit')).toBe('ア') // 非数値はそのまま
    expect(formatQuestionNumber(7, '第{n}問')).toBe('第7問')
  })
})
