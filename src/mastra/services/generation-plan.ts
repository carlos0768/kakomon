import type { Passage, Question } from '../schemas/exam.ts'

/**
 * 作問をバッチに分ける計画と、バッチ出力のマージ。
 * 1 回分 (数十問 + 全選択肢の根拠) を 1 回の呼び出しで出すと出力トークン上限 (finishReason=length) に
 * 当たるため、分野配分を保ったまま BATCH_SIZE 問ずつ生成して結合する。LLM を呼ばない決定的ロジック。
 */

export interface BatchPlan {
  /** 1 始まりのバッチ番号 */
  index: number
  /** この範囲の設問番号 (両端含む) */
  start: number
  end: number
  /** この範囲で作る分野ごとの問数 (要件定義の比率を全体に割り付けたもの) */
  quota: Array<{ domain: string; count: number }>
}

export function batchSizeFromEnv(): number {
  const n = Number(process.env.KAKOMON_GENERATE_BATCH)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 15
}

/** 要件定義の分野比率を count 問に割り付け (最大剰余法)、分野順に並べて batchSize 問ずつに切る */
export function planBatches(count: number, domains: Array<{ domain: string; share: number }>, batchSize: number): BatchPlan[] {
  const size = Math.max(1, Math.floor(batchSize))
  const total = domains.reduce((s, d) => s + Math.max(0, d.share), 0)
  const raw = domains.map(d => (total > 0 ? (Math.max(0, d.share) / total) * count : count / Math.max(1, domains.length)))
  const alloc = raw.map(Math.floor)
  let rest = count - alloc.reduce((a, b) => a + b, 0)
  const byFraction = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (const o of byFraction) {
    if (rest <= 0) break
    alloc[o.i]!++
    rest--
  }
  const slots: string[] = []
  domains.forEach((d, i) => {
    for (let k = 0; k < alloc[i]!; k++) slots.push(d.domain)
  })
  while (slots.length < count) slots.push(domains[0]?.domain ?? '一般')

  const batches: BatchPlan[] = []
  for (let s = 0; s < slots.length; s += size) {
    const chunk = slots.slice(s, s + size)
    const quota = new Map<string, number>()
    for (const d of chunk) quota.set(d, (quota.get(d) ?? 0) + 1)
    batches.push({ index: batches.length + 1, start: s + 1, end: s + chunk.length, quota: [...quota].map(([domain, n]) => ({ domain, count: n })) })
  }
  return batches
}

export interface GeneratedParts {
  passages: Passage[]
  questions: Question[]
  designNotes: string[]
}

/**
 * バッチ出力を結合する。番号は計画どおりに振り直し、余った設問は捨て、資料文 ID の衝突は
 * バッチ接頭辞を付けて回避する。戻り値は気づいた点 (管理者向けメモ)。
 */
export function mergeBatch(acc: GeneratedParts, batch: { passages?: Passage[]; questions: Question[]; designNotes?: string }, plan: BatchPlan): string[] {
  const notes: string[] = []
  const expected = plan.end - plan.start + 1
  const questions = batch.questions.slice(0, expected).map((q, i) => ({ ...q, number: plan.start + i }))
  if (batch.questions.length > expected) notes.push(`バッチ ${plan.index}: ${batch.questions.length - expected} 問多く出力されたため切り捨て`)
  if (batch.questions.length < expected) notes.push(`バッチ ${plan.index}: ${expected} 問の予定に対し ${batch.questions.length} 問しか出力されなかった`)

  const rename = new Map<string, string>()
  for (const p of batch.passages ?? []) {
    const existing = acc.passages.find(x => x.id === p.id)
    if (!existing) {
      acc.passages.push(p)
    } else if (existing.text !== p.text) {
      const id = `B${plan.index}-${p.id}`
      rename.set(p.id, id)
      acc.passages.push({ ...p, id })
    }
  }
  for (const q of questions) {
    if (q.passageId && rename.has(q.passageId)) q.passageId = rename.get(q.passageId)
    if (q.passageId && !acc.passages.some(p => p.id === q.passageId)) {
      notes.push(`問${q.number}: 資料文 ${q.passageId} が見つからないため参照を外した`)
      q.passageId = undefined
    }
  }
  acc.questions.push(...questions)
  if (batch.designNotes?.trim()) acc.designNotes.push(`[バッチ ${plan.index} 問${plan.start}〜${plan.end}] ${batch.designNotes.trim()}`)
  return notes
}

/** 校閲後の改訂 (指摘された設問だけの再出力) を番号で差し替える。資料文は id で upsert */
export function applyRevision(acc: GeneratedParts, patch: { passages?: Passage[]; questions: Question[]; designNotes?: string }): string[] {
  const notes: string[] = []
  for (const p of patch.passages ?? []) {
    const i = acc.passages.findIndex(x => x.id === p.id)
    if (i >= 0) acc.passages[i] = p
    else acc.passages.push(p)
  }
  for (const q of patch.questions) {
    const i = acc.questions.findIndex(x => x.number === q.number)
    if (i >= 0) acc.questions[i] = q
    else {
      notes.push(`改訂で未知の設問番号 ${q.number} が出力されたため無視`)
    }
  }
  if (patch.designNotes?.trim()) acc.designNotes.push(`[改訂] ${patch.designNotes.trim()}`)
  return notes
}
