import { describe, expect, it } from 'vitest'
import { applyRevision, mergeBatch, planBatches, type GeneratedParts } from '../src/mastra/services/generation-plan.ts'
import { makeQuestion } from './fixtures.ts'

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
})
