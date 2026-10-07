# 管理者ランブック

予想問題を作る主体は管理者。受験者は公開済みの問題を選んで解くだけ。

## 0. セットアップ

```bash
npm install
cp .env.example .env     # ANTHROPIC_API_KEY を設定
# (任意) PDF 出力したい場合: npx playwright install chromium
```

Node.js 22.18 以降が必要 (TypeScript を直接実行する)。

## 1. 過去問 PDF を登録する

写真を束ねた PDF でもよい。1 ファイル = 1 回分。

```bash
npm run admin -- ingest data/past-exams/2024.pdf --title "○○試験" --year 2024 --session "第1回"
```

出力例:

```json
{ "examId": "…", "questionCount": 50, "answeredCount": 50, "indexedVectors": 0, "extractionNotes": [] }
```

- `answeredCount` が `questionCount` より少ない (PDF に正答表が無い) 場合は、正解と根拠を AI に推定させる:

  ```bash
  npm run admin -- solve <examId>
  ```

  推定結果は `explanation` に `[AI推定 confidence=…]` と残るので、低い confidence の設問は目視で確認する。
- `extractionNotes` に判読不能箇所が出たら、該当ページを撮り直して `--id <examId>` 付きで再取り込みする。

## 2. 傾向を分析して出題要件定義を作る

2 年度以上登録してから実行する。

```bash
npm run admin -- analyze --title "○○試験" --focus "直近3年を重視"
```

- `specId` が返り、`docs/specs/<specId>.md` に要件定義が書き出される。
- 内容を確認し、修正したい場合は Studio の Workflows → `analyze-exam` で `focus` に指示を足して再実行するか、`--spec-id <specId>` で上書きする。

## 3. 予想問題を生成する

```bash
npm run admin -- generate --spec <specId> --title "2026年度 予想問題 第1回" --ref <参考にする過去問 examId>
```

- 作問 → 校閲 → (blocker があれば 1 回改訂) → 下書き保存 → `data/out/<examId>-answers.html` にプレビュー出力 → **承認待ちで停止** する。
- 画面に `runId` と下書きの `examId`、校閲スコア・指摘が表示される。

## 4. 確認して承認 / 却下する

`data/out/<examId>-answers.html` (正解・根拠つき) をブラウザで開いて確認。

```bash
npm run admin -- approve <runId>                 # 公開: data/out/<examId>.html / .pdf を生成し status=published
npm run admin -- approve <runId> --reject --note "問12 の正解が曖昧"   # 却下: status=archived
```

Studio からでも可能: Workflows → `generate-exam` → 該当 run → `admin-approval` に `{ "approved": true }` を入れて Resume。
HTTP からは `POST /kakomon/admin/runs/<runId>/approve`。

## 5. 受験者に公開されているものを確認する

```bash
npm run admin -- list exams
curl http://localhost:4111/kakomon/exams
```

非公開に戻す: `POST /kakomon/admin/exams/<examId>/status {"status":"archived"}`。

## 6. 受験者アカウント

受験者は `/kakomon` の画面から自分でユーザー名とパスワードを決めて登録する (メール不要)。管理者側の操作は次の 2 つだけ。

```bash
npm run admin -- list users                                  # 登録済みユーザーの一覧
npm run admin -- user reset-password <username> <newPassword> # パスワードを忘れた人の再設定 (本人のログインは全て無効化される)
npm run admin -- user create <username> <password>           # 管理者側で先に作っておきたい場合
```

## 7. サーバ起動

```bash
npm run dev      # Studio + API (http://localhost:4111)。受験者 UI は http://localhost:4111/kakomon
npm run build && npm run start   # 本番ビルド
```

テレメトリ送信 (posthog) を止めたい場合は `MASTRA_TELEMETRY_DISABLED=1`。

Vercel に載せる場合は `docs/05_vercel-deployment.md` を参照 (Supabase の DB と `KAKOMON_ADMIN_TOKEN` が必要)。

## 8. よくある質問

- **Studio と CLI で DB が別になる** → `KAKOMON_DB_URL` を絶対パス (`file:/abs/path/kakomon.db`) にする。
- **PDF が出ない** → `playwright-core` と Chromium が必要。`pdfSkippedReason` に理由が入る。HTML は常に出る。`KAKOMON_CHROMIUM_PATH` で既存の Chrome を指せる。
- **生成が要件から外れる** → `docs/specs/<specId>.md` の分野名・比率・mustNot を見直し、`--instructions` で補足を渡す。校閲の `issues` を読むと原因が分かる。
- **弱点分析ができない** → 同じアカウントで 2 回以上提出が必要。
- **受験者がパスワードを忘れた** → `npm run admin -- user reset-password <username> <newPassword>`。
