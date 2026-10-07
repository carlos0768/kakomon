-- kakomon: アプリ側のテーブル (Supabase / PostgreSQL 用)
-- Mastra 自身のテーブル (mastra_workflow_snapshot など) は PostgresStore が初回起動時に自動作成します。
-- このファイルは src/mastra/db/client.ts の DDL と同じ内容です (どちらも CREATE ... IF NOT EXISTS で冪等)。

CREATE TABLE IF NOT EXISTS exams (
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
);

CREATE TABLE IF NOT EXISTS questions (
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
);
CREATE INDEX IF NOT EXISTS idx_questions_domain_topic ON questions(domain, topic);

CREATE TABLE IF NOT EXISTS specs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  exam_id TEXT NOT NULL REFERENCES exams(id),
  status TEXT NOT NULL DEFAULT 'in_progress',
  answers_json TEXT NOT NULL DEFAULT '[]',
  result_json TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  submitted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id, submitted_at);

CREATE TABLE IF NOT EXISTS weakness_reports (
  user_id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- これらのテーブルはサーバ (Mastra) からのみ service role / postgres ロールで触る想定。
-- Supabase の PostgREST (anon キー) から直接読めないよう RLS を有効化しておく。
ALTER TABLE exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE specs ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE weakness_reports ENABLE ROW LEVEL SECURITY;
