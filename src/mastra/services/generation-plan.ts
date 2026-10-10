import type { Passage, Question } from '../schemas/exam.ts'
import type { SectionSpec } from '../schemas/spec.ts'

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
  /** この範囲で作る分野ごとの問数 (要件定義の比率を全体に割り付けたもの)。大問単位の計画では空 */
  quota: Array<{ domain: string; count: number }>
  /** 大問単位の計画で、このバッチが受け持つ大問 (と小問の範囲)。大問の区切りがない試験では無し */
  sections?: SectionSlot[]
}

/** バッチが受け持つ 1 つの大問の範囲。大きい大問は複数バッチに分かれるので from/count で範囲を示す */
export interface SectionSlot {
  section: number
  title?: string
  instruction?: string
  domains: string[]
  sharedPassage: boolean
  notes?: string
  /** この大問の何問目から (1 始まり) */
  from: number
  /** このバッチで作る小問数 */
  count: number
  /** この大問の小問数 (全体) */
  total: number
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

/**
 * 大問構成に沿ったバッチ計画。大問はできるだけ 1 つのバッチに収め、途中で切らない。
 * batchSize より大きい大問だけは複数バッチに分ける (その場合も大問番号と小問の範囲を明示する)。
 */
export function planSectionBatches(sections: SectionSpec[], batchSize: number): BatchPlan[] {
  const size = Math.max(1, Math.floor(batchSize))
  const batches: BatchPlan[] = []
  let current: SectionSlot[] = []
  let filled = 0
  let next = 1
  const flush = () => {
    if (!current.length) return
    batches.push({ index: batches.length + 1, start: next, end: next + filled - 1, quota: [], sections: current })
    next += filled
    current = []
    filled = 0
  }
  for (const sec of [...sections].sort((a, b) => a.number - b.number)) {
    let left = sec.questionCount
    let from = 1
    while (left > 0) {
      if (current.length && left > size - filled) flush()
      const take = Math.min(left, size - filled)
      current.push({
        section: sec.number,
        title: sec.title,
        instruction: sec.instruction,
        domains: sec.domains,
        sharedPassage: sec.sharedPassage,
        notes: sec.notes,
        from,
        count: take,
        total: sec.questionCount,
      })
      filled += take
      from += take
      left -= take
    }
  }
  flush()
  return batches
}

/**
 * 作問 LLM の出力を大問ごとの枠に振り分ける。section が付いている設問はその大問へ、
 * 付いていない (または計画にない大問の) 設問は空いている枠へ順に入れる。
 * 枠を超えた設問は捨て、足りない数は missing で返す (呼び出し側が追加作問する)。
 */
export function sortIntoSections(
  questions: Question[],
  slots: SectionSlot[],
  picked: Map<number, Question[]> = new Map(),
): { picked: Map<number, Question[]>; missing: Array<{ slot: SectionSlot; count: number }>; dropped: number } {
  const room = (slot: SectionSlot) => slot.count - (picked.get(slot.section)?.length ?? 0)
  const put = (slot: SectionSlot, q: Question) => picked.set(slot.section, [...(picked.get(slot.section) ?? []), { ...q, section: slot.section }])
  const unassigned: Question[] = []
  let dropped = 0
  for (const q of questions) {
    const slot = slots.find(s => s.section === q.section)
    if (!slot) unassigned.push(q)
    else if (room(slot) > 0) put(slot, q)
    else dropped++
  }
  for (const q of unassigned) {
    const slot = slots.find(s => room(s) > 0)
    if (slot) put(slot, q)
    else dropped++
  }
  const missing = slots.map(slot => ({ slot, count: room(slot) })).filter(m => m.count > 0)
  return { picked, missing, dropped }
}

/** 振り分けた設問を、計画の大問順に並べる */
export function orderBySections(picked: Map<number, Question[]>, slots: SectionSlot[]): Question[] {
  return slots.flatMap(s => picked.get(s.section) ?? [])
}

/**
 * 生成した設問が大問構成 (大問の数・大問ごとの小問数・並び) を守っているかを数えて検査する。
 * LLM の判断に頼らず決定的に検出するため、校閲とは別にコードで行う。戻り値は違反の説明 (空なら適合)。
 */
export function checkSectionStructure(questions: Array<Pick<Question, 'number' | 'section'>>, sections: SectionSpec[]): string[] {
  if (!sections.length) return []
  const problems: string[] = []
  const label = (n: number) => sections.find(s => s.number === n)?.title || `第${n}問`
  const unlabeled = questions.filter(q => q.section === undefined)
  if (unlabeled.length) problems.push(`所属する大問がない設問: ${unlabeled.map(q => `問${q.number}`).join(', ')}`)
  const counts = new Map<number, number>()
  for (const q of questions) if (q.section !== undefined) counts.set(q.section, (counts.get(q.section) ?? 0) + 1)
  const expected = [...sections].sort((a, b) => a.number - b.number)
  if (counts.size !== expected.length || [...counts.keys()].some(n => !expected.some(s => s.number === n))) {
    problems.push(`大問の数が ${counts.size} 個 (要件は ${expected.length} 個: ${expected.map(s => label(s.number)).join('・')})`)
  }
  for (const s of expected) {
    const actual = counts.get(s.number) ?? 0
    if (actual !== s.questionCount) problems.push(`${label(s.number)} の小問数が ${actual} 問 (要件は ${s.questionCount} 問)`)
  }
  for (const n of counts.keys()) {
    if (!expected.some(s => s.number === n)) problems.push(`要件にない大問 ${n} がある`)
  }
  const order = [...questions]
    .sort((a, b) => a.number - b.number)
    .flatMap(q => (q.section === undefined ? [] : [q.section]))
  if (order.some((sec, i) => i > 0 && sec < order[i - 1]!)) problems.push('大問の並びが崩れている (前の大問の小問が後ろに混ざっている)')
  return problems
}

export interface GeneratedParts {
  passages: Passage[]
  questions: Question[]
  designNotes: string[]
}

/**
 * バッチ出力を結合する。番号はそれまでの設問に続けて通しで振り直し (不足があっても番号を飛ばさない)、
 * 余った設問は捨て、資料文 ID の衝突はバッチ接頭辞を付けて回避する。戻り値は気づいた点 (管理者向けメモ)。
 */
export function mergeBatch(acc: GeneratedParts, batch: { passages?: Passage[]; questions: Question[]; designNotes?: string }, plan: BatchPlan): string[] {
  const notes: string[] = []
  const expected = plan.end - plan.start + 1
  const first = acc.questions.length + 1
  const questions = batch.questions.slice(0, expected).map((q, i) => ({ ...q, number: first + i }))
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

/** 校閲後の改訂 (指摘された設問だけの再出力) を番号で差し替える。資料文は id で upsert。所属する大問は差し替え前のまま保つ */
export function applyRevision(acc: GeneratedParts, patch: { passages?: Passage[]; questions: Question[]; designNotes?: string }): string[] {
  const notes: string[] = []
  for (const p of patch.passages ?? []) {
    const i = acc.passages.findIndex(x => x.id === p.id)
    if (i >= 0) acc.passages[i] = p
    else acc.passages.push(p)
  }
  for (const q of patch.questions) {
    const i = acc.questions.findIndex(x => x.number === q.number)
    if (i >= 0) acc.questions[i] = { ...q, section: acc.questions[i]!.section }
    else {
      notes.push(`改訂で未知の設問番号 ${q.number} が出力されたため無視`)
    }
  }
  if (patch.designNotes?.trim()) acc.designNotes.push(`[改訂] ${patch.designNotes.trim()}`)
  return notes
}
