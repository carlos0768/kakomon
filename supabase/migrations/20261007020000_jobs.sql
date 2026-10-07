-- kakomon: 管理画面から起動する非同期ジョブ (取り込み / 分析 / 作問 / 正解推定) の記録
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  title TEXT NOT NULL,
  run_id TEXT,
  input_json TEXT NOT NULL,
  result_json TEXT,
  suspend_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
