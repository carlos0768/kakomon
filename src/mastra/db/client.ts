import { createClient, type Client } from '@libsql/client'
import pg from 'pg'
import { config, pgSslOption } from '../config.ts'

/**
 * ドメインデータ用の DB アダプタ。
 * - ローカル開発: libSQL (SQLite ファイル / :memory:)
 * - 本番 (Vercel): Supabase などの PostgreSQL
 * SQL は `?` プレースホルダで書き、Postgres では `$n` に変換する。
 * 方言差は CURRENT_TIMESTAMP など両方で動く構文に寄せている。
 */

export type SqlArg = string | number | null
export interface Row {
  [column: string]: unknown
}
export interface DbExecutor {
  execute(sql: string, args?: SqlArg[]): Promise<Row[]>
}
export interface Db extends DbExecutor {
  dialect: 'libsql' | 'postgres'
  transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export const DDL = [
  `CREATE TABLE IF NOT EXISTS exams (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('past', 'predicted')),
    title TEXT NOT NULL,
    year INTEGER,
    session TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    source_file TEXT,
    spec_id TEXT,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS questions (
    exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    domain TEXT NOT NULL,
    topic TEXT NOT NULL,
    question_type TEXT NOT NULL,
    difficulty INTEGER NOT NULL,
    cognitive_level TEXT NOT NULL,
    correct_label TEXT,
    search_text TEXT NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (exam_id, number)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_questions_domain_topic ON questions(domain, topic)`,
  `CREATE TABLE IF NOT EXISTS specs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    exam_id TEXT NOT NULL REFERENCES exams(id),
    status TEXT NOT NULL DEFAULT 'in_progress',
    answers_json TEXT NOT NULL DEFAULT '[]',
    result_json TEXT,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    submitted_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id, submitted_at)`,
  `CREATE TABLE IF NOT EXISTS weakness_reports (
    user_id TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
]

export function isPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:\/\//i.test(url)
}

/** `?` プレースホルダを Postgres の `$1, $2, ...` に変換する (SQL リテラル内に ? は使わない前提) */
export function toPgPlaceholders(sql: string): string {
  let i = 0
  return sql.replace(/\?/g, () => `$${++i}`)
}

function createLibsqlDb(url: string, authToken?: string): Db {
  const client: Client = createClient({ url, authToken })
  const wrap = (c: { execute: Client['execute'] }): DbExecutor => ({
    async execute(sql, args = []) {
      const rs = await c.execute({ sql, args })
      return rs.rows as unknown as Row[]
    },
  })
  return {
    dialect: 'libsql',
    ...wrap(client),
    async transaction(fn) {
      const tx = await client.transaction('write')
      try {
        const out = await fn(wrap(tx))
        await tx.commit()
        return out
      } catch (err) {
        await tx.rollback().catch(() => undefined)
        throw err
      } finally {
        tx.close()
      }
    },
    async close() {
      client.close()
    },
  }
}

function createPostgresDb(connectionString: string): Db {
  // Supabase 等のマネージド PG は TLS 必須。証明書は検証しない設定 (no-verify) を既定にする
  const pool = new pg.Pool({ connectionString, ssl: pgSslOption(connectionString), max: config.isServerless ? 3 : 10 })
  const wrap = (c: { query: pg.Pool['query'] }): DbExecutor => ({
    async execute(sql, args = []) {
      const res = await c.query(toPgPlaceholders(sql), args)
      return res.rows as Row[]
    },
  })
  return {
    dialect: 'postgres',
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const out = await fn(wrap(client))
        await client.query('COMMIT')
        return out
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw err
      } finally {
        client.release()
      }
    },
    async close() {
      await pool.end()
    },
  }
}

let db: Db | undefined
let initialized: Promise<void> | undefined

export function getDb(): Db {
  if (!db) {
    db = isPostgresUrl(config.dbUrl) ? createPostgresDb(config.dbUrl) : createLibsqlDb(config.dbUrl, config.dbAuthToken)
  }
  return db
}

/** テーブル作成 (冪等)。各リポジトリ関数が最初に呼ぶ。Postgres では supabase/migrations の SQL と同じ内容 */
export function ensureSchema(): Promise<void> {
  if (!initialized) {
    initialized = (async () => {
      const d = getDb()
      for (const stmt of DDL) await d.execute(stmt)
    })()
  }
  return initialized
}

/** テスト用: 接続とスキーマ初期化状態をリセット。url 省略で libSQL の :memory: */
export async function resetDbForTests(url?: string): Promise<void> {
  if (db) await db.close().catch(() => undefined)
  const target = url ?? ':memory:'
  db = isPostgresUrl(target) ? createPostgresDb(target) : createLibsqlDb(target)
  initialized = undefined
  if (db.dialect === 'postgres') {
    await db.execute('DROP TABLE IF EXISTS sessions, users, weakness_reports, attempts, questions, specs, exams CASCADE')
  }
  await ensureSchema()
}
