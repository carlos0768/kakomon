import { createClient, type Client } from '@libsql/client'
import { config } from '../config.ts'

let client: Client | undefined
let initialized: Promise<void> | undefined

/**
 * ドメインデータ用の libSQL クライアント。
 * Mastra 自身のストレージ (ワークフロー状態など) と同じ DB ファイルを共有する。
 */
export function getDb(): Client {
  if (!client) {
    client = createClient({ url: config.dbUrl, authToken: config.dbAuthToken })
  }
  return client
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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    exam_id TEXT NOT NULL REFERENCES exams(id),
    status TEXT NOT NULL DEFAULT 'in_progress',
    answers_json TEXT NOT NULL DEFAULT '[]',
    result_json TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    submitted_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id, submitted_at)`,
  `CREATE TABLE IF NOT EXISTS weakness_reports (
    user_id TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
]

/** テーブル作成 (冪等)。各リポジトリ関数が最初に呼ぶ */
export function ensureSchema(): Promise<void> {
  if (!initialized) {
    initialized = (async () => {
      const db = getDb()
      for (const stmt of DDL) await db.execute(stmt)
    })()
  }
  return initialized
}

/** テスト用: 接続とスキーマ初期化状態をリセット */
export async function resetDbForTests(url?: string): Promise<void> {
  if (client) client.close()
  client = createClient({ url: url ?? ':memory:' })
  initialized = undefined
  await ensureSchema()
}
