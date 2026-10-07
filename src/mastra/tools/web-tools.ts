import { webFetchTool, webSearchTool } from '@mastra/core/tools'

/**
 * ネット検索ツール。
 * - webSearch: モデル提供元 (Anthropic) のサーバー側ウェブ検索。追加の API キーは不要で、検索自体は Anthropic 側で実行される
 * - webFetch: URL を指定してページ本文を取得 (Mastra 内蔵。localhost/プライベート IP は遮断、10 万文字で打ち切り)
 * KAKOMON_WEB_SEARCH=0 で無効化できる (検索は 1,000 回あたり約 $10 の従量課金)。
 */
export function isWebSearchEnabled(): boolean {
  return process.env.KAKOMON_WEB_SEARCH !== '0'
}

type WebTools = { webSearch: typeof webSearchTool; webFetch: typeof webFetchTool }

/** 無効時は空オブジェクト (スプレッドしても何も追加されない) */
export function webTools(): WebTools {
  return (isWebSearchEnabled() ? { webSearch: webSearchTool, webFetch: webFetchTool } : {}) as WebTools
}
