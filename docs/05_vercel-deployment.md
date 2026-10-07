# Vercel へのデプロイ

Vercel のフレームワーク一覧で **Mastra** を選んでインポートしている前提。Vercel は `mastra build` を実行し、`VercelDeployer` が出力する Build Output (`.vercel/output`) を配信する。

## 役割分担

| 場所 | 担当 |
|---|---|
| Vercel (サーバレス関数) | 受験者向け: 問題の閲覧・解答・添削・弱点分析 (`/kakomon/*`)。管理者向け Studio (`/`) と管理者 API |
| 手元の PC (CLI) | 過去問 PDF の取り込み、傾向分析、作問、PDF 出力。同じ Turso DB を指して実行する |

Vercel 上では **PDF 生成はできない** (Chromium が無い)。受験者には `/kakomon/exams/:id/print` の HTML 版を配信し、PDF が必要なら手元で `npm run admin -- render <examId>` を実行する。`ingest` もローカルのファイルパスを読むので手元で実行する。

## 1. Turso で DB を作る (必須)

Vercel のサーバレス環境ではローカルファイルが毎回消えるため、ローカル SQLite のままでは **データが残らない** (起動はするが、問題一覧が空のまま)。

```bash
# https://turso.tech でアカウント作成後
brew install tursodatabase/tap/turso   # または curl -sSfL https://get.tur.so/install.sh | bash
turso auth login
turso db create kakomon --location nrt   # 東京
turso db show kakomon --url              # libsql://kakomon-<org>.aws-ap-northeast-1.turso.io
turso db tokens create kakomon           # TURSO_AUTH_TOKEN
```

## 2. Vercel の環境変数

Vercel の Project → Settings → Environment Variables に設定する。

| 変数 | 値 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic の API キー |
| `KAKOMON_DB_URL` | `libsql://…turso.io` (手順 1 の URL) |
| `TURSO_AUTH_TOKEN` | 手順 1 のトークン |
| `KAKOMON_ADMIN_TOKEN` | 任意の長いランダム文字列。Studio と作問 API の保護に使う (**公開環境では必須**) |
| `MASTRA_TELEMETRY_DISABLED` | `1` (任意) |

設定後、Deployments から **Redeploy** する (環境変数はビルド時にも使われる)。

## 3. 動作確認

| URL | 期待 |
|---|---|
| `https://<project>.vercel.app/kakomon` | 受験者画面 (問題が無ければ「公開中の問題はありません」) |
| `https://<project>.vercel.app/kakomon/exams` | `{"exams":[]}` |
| `https://<project>.vercel.app/` | Studio のログイン画面。パスワード欄に `KAKOMON_ADMIN_TOKEN` を入れる |
| `https://<project>.vercel.app/api/workflows` | トークン無しで 401 |

## 4. 手元から本番 DB に問題を入れる

`.env` を本番と同じ DB に向ける。

```bash
KAKOMON_DB_URL=libsql://kakomon-<org>.aws-ap-northeast-1.turso.io
TURSO_AUTH_TOKEN=...
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

- `src/mastra/index.ts`: `process.env.VERCEL` が立っているときだけ `VercelDeployer({ studio: true })` を有効化。ローカルの `mastra build` は通常の Node サーバを出力する。
- `src/mastra/config.ts`: サーバレス環境でローカルファイル DB が指定されていたら `/tmp` にフォールバックし、警告を出す (`ephemeralDb`)。
- `KAKOMON_ADMIN_TOKEN` があれば `SimpleAuth` を有効化。受験者向けルートは `requiresAuth: false`。
- ローカルの本番ビルド (`npm run build && npm run start`) では `/` を `/kakomon` にリダイレクトする (Studio を同梱しないため)。

## トラブルシュート

- **404 のまま** → Vercel のビルドログに `Deployer found, preparing deployer build...` が出ているか確認。出ていなければ `VERCEL` 環境変数が無い (フレームワークに Mastra を選んでいない) か、古いコミットをデプロイしている。
- **問題一覧が常に空 / 承認したのに出ない** → `KAKOMON_DB_URL` が `file:` のままでデータが消えている。Function のログに `[kakomon] サーバレス環境でローカルファイル DB にフォールバック` が出る。
- **Studio でログインできない** → パスワード欄に `KAKOMON_ADMIN_TOKEN` をそのまま入れる (メール欄は無視される)。
- **添削が遅い / タイムアウト** → `KAKOMON_LIGHT_MODEL` をより速いモデルにするか、`maxDuration` を上げる (Vercel のプランによる上限あり)。
