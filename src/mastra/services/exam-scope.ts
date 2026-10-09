import type { RequestContext } from '@mastra/core/request-context'

/**
 * 過去問ツールが参照してよい過去問の範囲。
 *
 * 傾向分析で対象の過去問を選んだとき、アナリストがツール (一覧・統計・検索・取得) 経由で
 * 対象外の過去問まで読んでしまうと、別の試験の傾向が混ざる。
 * そこでワークフローが requestContext に対象 ID を載せ、ツール側でその範囲に絞る。
 * 載っていなければ従来どおり全件。
 */
export const EXAM_SCOPE_KEY = 'kakomon.examScope'

export function setExamScope(requestContext: RequestContext, examIds: string[]): void {
  requestContext.set(EXAM_SCOPE_KEY as never, examIds as never)
}

export function examScopeFrom(requestContext?: RequestContext): string[] | undefined {
  const v = requestContext?.get(EXAM_SCOPE_KEY as never)
  return Array.isArray(v) && v.every(x => typeof x === 'string') && v.length > 0 ? (v as string[]) : undefined
}

/** 要求された ID 群を範囲内に絞る。範囲が無ければそのまま、ID 未指定なら範囲全体 */
export function restrictToScope(scope: string[] | undefined, requested?: string[]): string[] | undefined {
  if (!scope) return requested?.length ? requested : undefined
  if (!requested?.length) return scope
  return requested.filter(id => scope.includes(id))
}
