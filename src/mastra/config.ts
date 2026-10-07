import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 環境変数から読み込む設定。
 * 既定モデルは Claude Opus 5.5 (Mastra model router 形式 `anthropic/claude-opus-5-5`)。
 */
/**
 * プロジェクトルート。`mastra dev` はバンドル先に cwd を移すため、process.cwd() は当てにならない。
 * package.json と src/mastra を持つディレクトリを上に辿って探す (KAKOMON_ROOT で明示も可)。
 * サーバレス環境では見つからないので /tmp を使う。
 */
export function findProjectRoot(): string {
  if (process.env.KAKOMON_ROOT) return path.resolve(process.env.KAKOMON_ROOT)
  let dir = process.cwd()
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'src', 'mastra'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return isServerless() ? '/tmp/kakomon' : process.cwd()
}

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
  /** Vercel / Lambda 上で動いているか (接続プール数などの調整に使う) */
  isServerless: isServerless(),
  /** DB 方言。postgres:// / postgresql:// なら Postgres (Supabase 等)、それ以外は libSQL */
  dbDialect: (/^postgres(ql)?:\/\//i.test(process.env.KAKOMON_DB_URL ?? '') ? 'postgres' : 'libsql') as 'postgres' | 'libsql',
  /** ベクトル検索用の埋め込みモデル (未設定なら無効) */
  embeddingModel: process.env.EMBEDDING_MODEL,
  /** 管理者 API を保護するトークン (未設定なら未保護: ローカル開発用) */
  adminToken: process.env.KAKOMON_ADMIN_TOKEN,
  /** プロジェクトルート (data/ や docs/specs の基準) */
  projectRoot: findProjectRoot(),
  /** 生成物 (HTML/PDF) の出力先 */
  outDir: path.resolve(findProjectRoot(), process.env.KAKOMON_OUT_DIR ?? 'data/out'),
  /** アップロードした過去問 PDF の保存先 */
  uploadDir: path.resolve(findProjectRoot(), 'data/past-exams'),
}

function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)
}

function isLocalFileUrl(url: string): boolean {
  return url.startsWith('file:') || url === ':memory:'
}

export function isPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:\/\//i.test(url)
}

/**
 * node-postgres 用の ssl オプション。
 * ローカル (localhost) や sslmode=disable では無効、それ以外 (Supabase 等のマネージド PG) では
 * TLS を使い、証明書は検証しない (no-verify 相当)。
 */
export function pgSslOption(url: string): { rejectUnauthorized: false } | undefined {
  try {
    const u = new URL(url)
    const local = ['localhost', '127.0.0.1', '::1', '[::1]', ''].includes(u.hostname)
    const sslmode = u.searchParams.get('sslmode')
    if (local || sslmode === 'disable') return undefined
  } catch {
    // URL として解釈できない場合は TLS 側に倒す
  }
  return { rejectUnauthorized: false }
}

function resolveDbUrl(url: string): string {
  // Vercel などの読み取り専用 FS では /tmp にしか書けない (再起動で消える)
  if (isServerless() && isLocalFileUrl(url)) return 'file:/tmp/kakomon.db'
  if (url.startsWith('file:') && !url.startsWith('file:/')) {
    return `file:${path.resolve(findProjectRoot(), url.slice('file:'.length))}`
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
