-- kakomon: ジョブの進捗 (出力文字数・フェーズ・経過) を管理画面に出すための列
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS progress_json TEXT;
