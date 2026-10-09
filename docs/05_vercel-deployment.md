# Vercel + Supabase へのデプロイ

Vercel のフレームワーク一覧で **Mastra** を選んでインポートしている前提。Vercel は `mastra build` を実行し、`VercelDeployer` が出力する Build Output (`.vercel/output`) を配信する。DB は Supabase (PostgreSQL)。

## 役割分担

| 場所 | 担当 |
|---|---|
| Vercel (サーバレス関数) | 受験者向け: 問題の閲覧・解答・添削・弱点分析 (`/kakomon/*`)。管理画面 (`/kakomon/admin`)、Studio (`/`)、管理者 API |
| Supabase (PostgreSQL) | すべてのデータ (過去問・要件定義・予想問題・解答履歴・Mastra のワークフロー状態) |
| 手元の PC (CLI) | 過去問 PDF の取り込み、傾向分析、作問、PDF 出力。同じ Supabase DB を指して実行する |

Vercel 上の管理画面では取り込み・分析・作問・正解推定の**ボタンは無効化**されている (API も 400 を返す)。サーバレス関数は応答を返した直後に止まるため、バックグラウンドのジョブは「実行中」の記録だけ残して途中で死ぬ。**重い作業は手元の `npm run dev` で開いた管理画面から行う** (同じ Supabase を見ているので結果はそのままサイトに出る)。承認・公開切替・ユーザー管理は Vercel 上の管理画面でできる。15 分以上進捗の無い「実行中」ジョブは、次にジョブ一覧を開いたときに自動で失敗扱いになる。

Vercel 上では **PDF 生成はできない** (Chromium が無い)。受験者には `/kakomon/exams/:id/print` の HTML 版を配信し、PDF が必要なら手元で `npm run admin -- render <examId>` を実行する。`ingest` もローカルのファイルパスを読むので手元で実行する。

## 1. Supabase プロジェクトと接続文字列

1. https://supabase.com でプロジェクトを作る (リージョンは Tokyo `ap-northeast-1` 推奨)。
2. Project Settings → Database → **Connection string** を開き、**Transaction pooler** (ポート 6543) の URI をコピーする。サーバレスからは必ずこちらを使う (直接接続の 5432 はコネクション数の上限にすぐ当たる)。

   ```
   postgresql://postgres.<project-ref>:<password>@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres
   ```

   `<password>` はプロジェクト作成時の DB パスワード (忘れたら同じ画面で Reset)。

## 2. マイグレーション

アプリのテーブルは `supabase/migrations/20261007000000_kakomon_init.sql` にある。適用方法は 3 つのうちどれでもよい (すべて冪等)。

| 方法 | コマンド |
|---|---|
| Supabase CLI | `supabase link --project-ref <ref>` → `supabase db push` |
| このリポジトリの CLI | `.env` の `KAKOMON_DB_URL` を Supabase に向けて `npm run db:migrate` |
| SQL Editor | ダッシュボードの SQL Editor にファイルの中身を貼って実行 |

Mastra 自身のテーブル (`mastra_workflow_snapshot`, `mastra_threads` など) は、サーバの初回起動時に `PostgresStore` が自動で作る。手動の作業は不要。

マイグレーションでは RLS (Row Level Security) を有効化している。アプリは `postgres` ロールで接続するので影響はなく、Supabase の自動 REST API (anon キー) からテーブルを直接読まれるのを防ぐためのもの。

## 3. Vercel の環境変数

Vercel の Project → Settings → Environment Variables に設定する。

| 変数 | 値 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic の API キー |
| `KAKOMON_DB_URL` | 手順 1 の Transaction pooler URI (`postgresql://…:6543/postgres`) |
| `KAKOMON_ADMIN_TOKEN` | 任意の長いランダム文字列。Studio と作問 API の保護に使う (**公開環境では必須**) |
| `MASTRA_TELEMETRY_DISABLED` | `1` (任意) |

設定後、Deployments から **Redeploy** する (環境変数はビルド時にも使われる)。

## 4. 動作確認

まず `https://<project>.vercel.app/kakomon/health` を開く。DB の設定状況と接続結果が JSON で返る (秘密情報は含まない)。

| フィールド | 正常な値 | 異常なときの意味 |
|---|---|---|
| `dbDialect` | `postgres` | `libsql` なら `KAKOMON_DB_URL` が Vercel に設定されていない (または Redeploy していない) |
| `dbConfigured` | `true` | `false` なら環境変数が未設定 |
| `db` | `ok` | `error` なら `dbError` に原因 (パスワード違い、ホスト違い、SSL など) |
| `adminTokenConfigured` | `true` | `false` なら Studio と作問 API が無認証で公開されている |

| URL | 期待 |
|---|---|
| `https://<project>.vercel.app/kakomon` | 受験者画面 (問題が無ければ「公開中の問題はありません」) |
| `https://<project>.vercel.app/kakomon/exams` | `{"exams":[]}` |
| `https://<project>.vercel.app/` | Studio のログイン画面。パスワード欄に `KAKOMON_ADMIN_TOKEN` を入れる |
| `https://<project>.vercel.app/api/workflows` | トークン無しで 401 |

Supabase の Table Editor に `exams` や `mastra_workflow_snapshot` が見えていれば接続できている。

## 5. 手元から本番 DB に問題を入れる

`.env` を本番と同じ DB に向ける。

```bash
KAKOMON_DB_URL=postgresql://postgres.<ref>:<password>@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres
ANTHROPIC_API_KEY=...
```

あとは通常どおり (`docs/04_admin-runbook.md`)。

```bash
npm run admin -- ingest data/past-exams/2024.pdf --year 2024
npm run admin -- analyze --title "○○試験"
npm run admin -- generate --spec <specId> --title "予想問題 第1回"
npm run admin -- approve <runId>
```

承認した時点で Vercel 側の `/kakomon` に表示される (同じ DB を見ているため再デプロイ不要)。

承認は Vercel 上の Studio からも行える: Workflows → `generate-exam` → 該当 run → `admin-approval` に `{"approved": true}` を入れて Resume。ただし Vercel 上で `generate` を回すと関数の実行時間上限 (300 秒に設定) に当たりやすいので、作問は手元の CLI 推奨。

## 仕組み (コード側)

- `src/mastra/db/client.ts`: `KAKOMON_DB_URL` が `postgresql://` なら `pg`、それ以外は libSQL を使うアダプタ。SQL は両方で動く構文に寄せている。
- `src/mastra/index.ts`: Postgres なら `PostgresStore`、それ以外は `LibSQLStore`。`process.env.VERCEL` が立っているときだけ `VercelDeployer({ studio: true })`。
- `src/mastra/tools/vector-search.ts`: ベクトル検索を有効にした場合 (`EMBEDDING_MODEL`)、Postgres では pgvector (`PgVector`) を使う。Supabase では Database → Extensions で `vector` を有効にしておく。
- `KAKOMON_ADMIN_TOKEN` があれば `SimpleAuth` を有効化。受験者向けルートは `requiresAuth: false`。
- サーバレス環境でローカルファイル DB のままなら `/tmp` にフォールバックし、警告を出す (`ephemeralDb`)。

## トラブルシュート

- **登録やログインで「サーバ側のエラー」/ Internal Server Error** → `/kakomon/health` を開いて `db` と `dbError` を見る。たいていは `KAKOMON_DB_URL` 未設定 (Redeploy 忘れ) かパスワード違い。
- **404 のまま** → Vercel のビルドログに `Deployer found, preparing deployer build...` が出ているか確認。出ていなければフレームワークに Mastra を選んでいないか、古いコミットをデプロイしている。
- **問題一覧が常に空 / 承認したのに出ない** → `KAKOMON_DB_URL` が未設定で `file:` のままになっている。Function のログに `[kakomon] サーバレス環境でローカルファイル DB にフォールバック` が出る。
- **アップロードで 413 (Payload Too Large)** → Vercel の関数はリクエスト本文 4.5MB までというプラットフォーム側の制限があり、設定では変えられない。それより大きい PDF は手元で `npm run dev` を起動した管理画面からアップロードする (同じ Supabase を見ているので結果はサイトに反映される)。手元で 413 が出る場合は `.env` の `KAKOMON_MAX_UPLOAD_MB` (既定 32) を確認する。
- **`too many connections` / 接続エラー** → 直接接続 (5432) ではなく Transaction pooler (6543) の URI を使う。
- **`password authentication failed`** → URI の `<password>` に記号が含まれる場合は URL エンコードする (`@` → `%40` など)。
- **Studio でログインできない** → パスワード欄に `KAKOMON_ADMIN_TOKEN` をそのまま入れる (メール欄は無視される)。
- **添削が遅い / タイムアウト** → `KAKOMON_LIGHT_MODEL` をより速いモデルにするか、`maxDuration` を上げる (Vercel のプランによる上限あり)。
