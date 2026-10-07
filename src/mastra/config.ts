import path from 'node:path'

/**
 * 環境変数から読み込む設定。
 * 既定モデルは Claude Opus 5.5 (Mastra model router 形式 `anthropic/claude-opus-5-5`)。
 */
export const config = {
  /** 作問・分析など重い処理に使うモデル */
  model: process.env.KAKOMON_MODEL ?? 'anthropic/claude-opus-5-5',
  /** 添削・弱点分析など軽めの処理に使うモデル */
  lightModel: process.env.KAKOMON_LIGHT_MODEL ?? process.env.KAKOMON_MODEL ?? 'anthropic/claude-opus-5-5',
  /** libSQL の接続 URL。Studio / CLI / サーバで同じ DB を見るため絶対パスに解決する */
  dbUrl: resolveDbUrl(process.env.KAKOMON_DB_URL ?? 'file:./kakomon.db'),
  /** Turso など認証が必要なリモート libSQL のトークン */
  dbAuthToken: process.env.TURSO_AUTH_TOKEN || process.env.KAKOMON_DB_AUTH_TOKEN || undefined,
  /** サーバレス環境 (Vercel) でローカルファイル DB にフォールバックしている場合 true。データは永続化されない */
  ephemeralDb: isServerless() && isLocalFileUrl(process.env.KAKOMON_DB_URL ?? 'file:./kakomon.db'),
  /** ベクトル検索用の埋め込みモデル (未設定なら無効) */
  embeddingModel: process.env.EMBEDDING_MODEL,
  /** 管理者 API を保護するトークン (未設定なら未保護: ローカル開発用) */
  adminToken: process.env.KAKOMON_ADMIN_TOKEN,
  /** 生成物 (HTML/PDF) の出力先 */
  outDir: path.resolve(process.cwd(), process.env.KAKOMON_OUT_DIR ?? 'data/out'),
}

function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)
}

function isLocalFileUrl(url: string): boolean {
  return url.startsWith('file:') || url === ':memory:'
}

function resolveDbUrl(url: string): string {
  // Vercel などの読み取り専用 FS では /tmp にしか書けない (再起動で消える)
  if (isServerless() && isLocalFileUrl(url)) return 'file:/tmp/kakomon.db'
  if (url.startsWith('file:') && !url.startsWith('file:/')) {
    return `file:${path.resolve(process.cwd(), url.slice('file:'.length))}`
  }
  return url
}

/**
 * Anthropic 向け providerOptions。
 * Claude Opus 5.5 は thinking 常時 ON のため、深さは effort で制御する。
 * `fallbacks: 'default'` で安全分類器による拒否時にサーバ側フォールバックを有効化。
 */
export function anthropicOptions(effort: 'low' | 'medium' | 'high' | 'xhigh' = 'high') {
  return {
    anthropic: {
      thinking: { type: 'adaptive' as const },
      effort,
      fallbacks: 'default' as const,
    },
  }
}
