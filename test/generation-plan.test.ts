import { describe, expect, it } from 'vitest'
import {
  applyRevision,
  checkSectionStructure,
  mergeBatch,
  orderBySections,
  planBatches,
  planSectionBatches,
  sortIntoSections,
  type GeneratedParts,
} from '../src/mastra/services/generation-plan.ts'
import type { SectionSpec } from '../src/mastra/schemas/spec.ts'
import { makeQuestion } from './fixtures.ts'

const sec = (number: number, questionCount: number, over: Partial<SectionSpec> = {}): SectionSpec => ({
  number,
  questionCount,
  domains: [],
  sharedPassage: false,
  ...over,
})

describe('planBatches', () => {
  it('allocates by share with largest remainder and keeps domain order', () => {
    const plan = planBatches(10, [{ domain: 'A', share: 0.55 }, { domain: 'B', share: 0.45 }], 4)
    expect(plan.map(b => [b.start, b.end])).toEqual([[1, 4], [5, 8], [9, 10]])
    const total = new Map<string, number>()
    for (const b of plan) for (const q of b.quota) total.set(q.domain, (total.get(q.domain) ?? 0) + q.count)
    expect([...total]).toEqual([['A', 6], ['B', 4]]) // 5.5 → 6 (端数が大きい方に +1), 4.5 → 4
    expect(plan[0]!.quota).toEqual([{ domain: 'A', count: 4 }])
    expect(plan[1]!.quota).toEqual([{ domain: 'A', count: 2 }, { domain: 'B', count: 2 }])
  })

  it('covers the full count even when shares do not sum to 1 or domains are empty', () => {
    expect(planBatches(7, [{ domain: 'X', share: 0 }], 3).map(b => b.end)).toEqual([3, 6, 7])
    expect(planBatches(2, [], 5)[0]!.quota).toEqual([{ domain: '一般', count: 2 }])
  })
})

describe('planSectionBatches', () => {
  it('packs whole sections into batches without splitting a section that fits', () => {
    const plan = planSectionBatches([sec(1, 4), sec(2, 3), sec(3, 5)], 8)
    expect(plan.map(b => [b.start, b.end])).toEqual([[1, 7], [8, 12]])
    expect(plan[0]!.sections!.map(s => [s.section, s.from, s.count, s.total])).toEqual([[1, 1, 4, 4], [2, 1, 3, 3]])
    expect(plan[1]!.sections!.map(s => [s.section, s.from, s.count, s.total])).toEqual([[3, 1, 5, 5]])
    expect(plan.every(b => b.quota.length === 0)).toBe(true)
  })

  it('splits only a section larger than the batch size, keeping its sub-question range', () => {
    const plan = planSectionBatches([sec(1, 2), sec(2, 7), sec(3, 1)], 3)
    expect(plan.map(b => b.sections!.map(s => `${s.section}:${s.from}+${s.count}`))).toEqual([['1:1+2'], ['2:1+3'], ['2:4+3'], ['2:7+1', '3:1+1']])
    expect(plan.at(-1)!.end).toBe(10)
  })
})

describe('sortIntoSections', () => {
  const slots = planSectionBatches([sec(1, 2), sec(2, 2)], 10)[0]!.sections!

  it('puts labelled questions into their section, fills the rest in order, drops overflow and reports shortages', () => {
    const qs = [
      makeQuestion({ number: 1, section: 2, stem: 'a' }),
      makeQuestion({ number: 2, section: 2, stem: 'b' }),
      makeQuestion({ number: 3, section: 2, stem: 'c' }), // 第2問は 2 問まで → 捨てる
      makeQuestion({ number: 4, stem: 'd' }), // 大問なし → 空いている第1問へ
      makeQuestion({ number: 5, section: 9, stem: 'e' }), // 計画にない大問 → 空いている第1問へ
    ]
    const fit = sortIntoSections(qs, slots)
    expect(fit.dropped).toBe(1)
    expect(fit.missing).toEqual([])
    expect(orderBySections(fit.picked, slots).map(q => [q.section, q.stem])).toEqual([[1, 'd'], [1, 'e'], [2, 'a'], [2, 'b']])
  })

  it('reports missing sub-questions and can be topped up into the same buckets', () => {
    const fit = sortIntoSections([makeQuestion({ number: 1, section: 1 })], slots)
    expect(fit.missing.map(m => [m.slot.section, m.count])).toEqual([[1, 1], [2, 2]])
    const again = sortIntoSections([makeQuestion({ number: 1 }), makeQuestion({ number: 2, section: 2 }), makeQuestion({ number: 3, section: 2 })], slots, fit.picked)
    expect(again.missing).toEqual([])
    expect(orderBySections(again.picked, slots).map(q => q.section)).toEqual([1, 1, 2, 2])
  })
})

describe('checkSectionStructure', () => {
  const spec = [sec(1, 2, { title: '第1問' }), sec(2, 1, { title: '第2問' })]

  it('passes when section count, sub-question counts and order match', () => {
    const qs = [{ number: 1, section: 1 }, { number: 2, section: 1 }, { number: 3, section: 2 }]
    expect(checkSectionStructure(qs, spec)).toEqual([])
    expect(checkSectionStructure([{ number: 1 }], [])).toEqual([]) // 大問構成のない試験は検査しない
  })

  it('reports wrong sub-question counts, extra sections, missing labels and broken order', () => {
    expect(checkSectionStructure([{ number: 1, section: 1 }, { number: 2, section: 2 }, { number: 3, section: 2 }], spec)).toEqual([
      '第1問 の小問数が 1 問 (要件は 2 問)',
      '第2問 の小問数が 2 問 (要件は 1 問)',
    ])
    expect(checkSectionStructure([{ number: 1, section: 1 }, { number: 2, section: 1 }, { number: 3, section: 2 }, { number: 4, section: 3 }], spec)).toEqual([
      '大問の数が 3 個 (要件は 2 個: 第1問・第2問)',
      '要件にない大問 3 がある',
    ])
    expect(checkSectionStructure([{ number: 1, section: 1 }, { number: 2, section: 2 }, { number: 3, section: 1 }], spec)).toEqual([
      '大問の並びが崩れている (前の大問の小問が後ろに混ざっている)',
    ])
    expect(checkSectionStructure([{ number: 1, section: 1 }, { number: 2, section: 1 }, { number: 3 }], spec)).toEqual([
      '所属する大問がない設問: 問3',
      '大問の数が 1 個 (要件は 2 個: 第1問・第2問)',
      '第2問 の小問数が 0 問 (要件は 1 問)',
    ])
  })
})

describe('mergeBatch / applyRevision', () => {
  it('renumbers, truncates extras, and resolves passage id collisions', () => {
    const acc: GeneratedParts = { passages: [], questions: [], designNotes: [] }
    const plan1 = { index: 1, start: 1, end: 2, quota: [] }
    const plan2 = { index: 2, start: 3, end: 4, quota: [] }
    const n1 = mergeBatch(acc, { passages: [{ id: 'P1', text: '本文A' }], questions: [makeQuestion({ number: 9, passageId: 'P1' }), makeQuestion({ number: 10 }), makeQuestion({ number: 11 })], designNotes: 'メモ1' }, plan1)
    expect(n1).toEqual(['バッチ 1: 1 問多く出力されたため切り捨て'])
    expect(acc.questions.map(q => q.number)).toEqual([1, 2])
    const n2 = mergeBatch(acc, { passages: [{ id: 'P1', text: '本文B (別物)' }], questions: [makeQuestion({ number: 1, passageId: 'P1' }), makeQuestion({ number: 2, passageId: 'NOPE' })] }, plan2)
    expect(acc.passages.map(p => p.id)).toEqual(['P1', 'B2-P1'])
    expect(acc.questions.map(q => [q.number, q.passageId])).toEqual([[1, 'P1'], [2, undefined], [3, 'B2-P1'], [4, undefined]])
    expect(n2).toEqual(['問4: 資料文 NOPE が見つからないため参照を外した'])
    expect(acc.designNotes).toEqual(['[バッチ 1 問1〜2] メモ1'])

    const n3 = applyRevision(acc, { questions: [makeQuestion({ number: 3, stem: '改訂済み' }), makeQuestion({ number: 99 })], passages: [{ id: 'P1', text: '本文A 改訂' }] })
    expect(acc.questions[2]!.stem).toBe('改訂済み')
    expect(acc.questions).toHaveLength(4)
    expect(acc.passages[0]!.text).toBe('本文A 改訂')
    expect(n3).toEqual(['改訂で未知の設問番号 99 が出力されたため無視'])
  })

  it('numbers following batches without gaps when a batch came up short, and keeps the section on revision', () => {
    const acc: GeneratedParts = { passages: [], questions: [], designNotes: [] }
    mergeBatch(acc, { questions: [makeQuestion({ number: 1, section: 1 })] }, { index: 1, start: 1, end: 2, quota: [] })
    mergeBatch(acc, { questions: [makeQuestion({ number: 1, section: 2 })] }, { index: 2, start: 3, end: 3, quota: [] })
    expect(acc.questions.map(q => [q.number, q.section])).toEqual([[1, 1], [2, 2]])
    applyRevision(acc, { questions: [makeQuestion({ number: 2, section: 1, stem: '改訂' })] })
    expect(acc.questions[1]).toMatchObject({ number: 2, section: 2, stem: '改訂' })
  })
})
