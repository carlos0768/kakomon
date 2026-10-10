import type { ExtractedExam } from '../schemas/exam.ts'
import type { ExamSpec, SectionSpec } from '../schemas/spec.ts'

/**
 * 過去問の大問構成 (大問の数・大問ごとの小問数) を実データから数え、要件定義に反映する。
 * 構成は「数えれば分かる事実」なので LLM の読み取りに任せず、コードで決める。LLM を呼ばない決定的ロジック。
 */

/** 過去問 1 回分の大問構成を数える。設問に大問の情報がなければ undefined (大問の区切りがない or 未記録) */
export function observeSections(exam: Pick<ExtractedExam, 'questions' | 'sections'>): SectionSpec[] | undefined {
  if (!exam.questions.some(q => q.section !== undefined)) return undefined
  const numbers = [...new Set(exam.questions.map(q => q.section).filter((n): n is number => n !== undefined))].sort((a, b) => a - b)
  return numbers.map(n => {
    const qs = exam.questions.filter(q => q.section === n)
    const head = exam.sections.find(s => s.number === n)
    const passageIds = new Set(qs.map(q => q.passageId))
    return {
      number: n,
      title: head?.title,
      instruction: head?.instruction,
      questionCount: qs.length,
      domains: [...new Set(qs.map(q => q.domain))],
      sharedPassage: qs.length > 1 && passageIds.size === 1 && !passageIds.has(undefined),
    }
  })
}

/** 大問構成の形 (大問ごとの小問数の並び)。見出しや分野が違っても形が同じなら同じ値になる */
export function sectionShape(sections: Array<Pick<SectionSpec, 'number' | 'questionCount'>>): string {
  return [...sections]
    .sort((a, b) => a.number - b.number)
    .map(s => s.questionCount)
    .join('-')
}

/** 管理者・LLM 向けに大問構成を 1 行で表す (例: 第1問 5問 / 第2問 8問) */
export function describeSections(sections: Array<Pick<SectionSpec, 'number' | 'title' | 'questionCount'>>): string {
  return [...sections]
    .sort((a, b) => a.number - b.number)
    .map(s => `${s.title || `第${s.number}問`} ${s.questionCount}問`)
    .join(' / ')
}

export interface ObservedStructure {
  examId: string
  year?: number
  sections: SectionSpec[]
}

/**
 * 分析 LLM が書いた要件定義の大問構成を、過去問の実測に合わせて補正する (spec を直接書き換える)。
 * - 全年度で形が同じなら、その形 (大問の数・小問数) を必ず使う。見出し・指示文・分野は LLM の記述を優先して残す
 * - 年度で形が違うなら LLM の選択を尊重し、LLM が書いていなければ最新年度の形を使う
 * - 大問構成があれば questionCount はその小問数の合計にそろえる
 * 戻り値は補正した内容の説明 (管理者向けメモ)。
 */
export function reconcileSpecSections(spec: ExamSpec, observed: ObservedStructure[]): string[] {
  const notes: string[] = []
  const known = observed.filter(o => o.sections.length)
  if (known.length) {
    const latest = [...known].sort((a, b) => (b.year ?? 0) - (a.year ?? 0))[0]!
    const shapes = new Set(known.map(o => sectionShape(o.sections)))
    const current = spec.format.sections
    if (shapes.size === 1 && sectionShape(current) !== sectionShape(latest.sections)) {
      spec.format.sections = latest.sections.map(s => {
        const written = current.find(c => c.number === s.number)
        return written ? { ...written, questionCount: s.questionCount } : s
      })
      notes.push(
        `大問構成を過去問の実測に合わせて補正: ${current.length ? describeSections(current) : '(未記入)'} → ${describeSections(spec.format.sections)}`,
      )
    } else if (!current.length) {
      spec.format.sections = latest.sections
      notes.push(`大問構成が年度で異なるため、最新年度 (examId=${latest.examId}) の構成を採用: ${describeSections(latest.sections)}`)
    }
  }
  if (spec.format.sections.length) {
    const total = spec.format.sections.reduce((n, s) => n + s.questionCount, 0)
    if (spec.format.questionCount !== total) {
      notes.push(`設問数を大問構成の合計に合わせて ${spec.format.questionCount} → ${total} 問に補正`)
      spec.format.questionCount = total
    }
  }
  return notes
}
