# 管理者ランブック

予想問題を作る主体は管理者。受験者は公開済みの問題を選んで解くだけ。

管理作業は **ブラウザの管理画面 (`/kakomon/admin`)** で行う。コマンドラインは起動と非常時だけ。

## 0. セットアップ (1 回だけ)

```bash
npm install
cp .env.example .env     # ANTHROPIC_API_KEY と KAKOMON_DB_URL (Supabase の pooler URI) を設定
npm run dev              # http://localhost:4111/kakomon/admin を開く
```

- 手元の `.env` を本番と同じ Supabase に向けると、ここで承認した問題がそのままサイト (Vercel) に出る。
- Vercel 上にも同じ管理画面 (`https://<project>.vercel.app/kakomon/admin`) があり、`KAKOMON_ADMIN_TOKEN` でログインする。ただし取り込み・作問は数分かかるので、Vercel の関数時間上限 (300 秒) に当たりやすい。**重い作業は手元の `npm run dev` で開いた管理画面から行う**のが確実。
- PDF も出したい場合は `npx playwright install chromium` を 1 回実行 (無くても HTML は出る)。

## 管理画面の流れ

| 画面の節 | やること |
|---|---|
| 1. 過去問 | PDF を選んで「アップロードして取り込む」。「ジョブ」が success になると一覧に設問数と正解の有無が出る。正解が足りなければ「正解を推定」 |
| 2. 要件定義 | 「分析を実行」。できた要件定義は「内容を見る」で確認。違和感があれば追加指示を入れて再実行 |
| 3. 予想問題 | 要件定義とタイトルを選んで「作問を開始」。承認待ちになったら「内容を確認 (正解つき)」→「承認して公開」または「却下」。公開/非公開の切替もここ |
| ジョブ | 取り込み・分析・作問・正解推定の進行状況と結果。実行中は経過時間・段階・モデルの出力文字数が 5 秒ごとに更新される。失敗時はエラー内容が出る |

### 取り込みにかかる時間と進み方

取り込みは「PDF を保存する」のではなく、Claude が写真 PDF の全ページを読んで設問ごとの構造化データ (問題文・選択肢・正解・分野・難易度・レイアウト) に起こす工程。1 回の長い呼び出しなので、ページ数と文章量に比例して数分から 10 分以上かかる。

- 「ジョブ」の行に `設問 N 件目まで出力 / 出力 M 文字` が増えていれば進んでいる。
- `※ 3 分以上更新なし` と出たら、サーバ (`npm run dev`) が止まっているかネットが切れている。再起動して同じ PDF をもう一度アップロードする。
- 同じ過去問の取り込みが走っている間は、同じファイル・同じ試験名の再アップロードは 409 で止まる (費用が倍になるため)。
- ジョブ開始前に Anthropic API への小さな疎通確認を行い、キー無効やクレジット不足はその場で表示される。
- モデル呼び出しはすべてストリーミング。非ストリーミングだと出力完了まで応答ヘッダが返らず、5 分を超えると Node の fetch が `headers timeout after 300000` で切ってしまう (取り込みが 16 分後に失敗した原因)。
- 長文読解の本文など複数の設問で共有される資料文は `passages` に 1 回だけ保存され、設問は `passageId` で参照する。表示・印刷ではその資料文が最初の設問の前に 1 回だけ出る。
- 読み取りだけ別のモデルにしたい場合は `KAKOMON_EXTRACT_MODEL` を設定する (既定は `KAKOMON_MODEL`)。
| ユーザー | 受験者一覧とパスワード再設定 |

以下はコマンドラインで同じことをする場合の手順。

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

### 作問の進み方

1 回分を一度に出させると出力トークンの上限に当たって途中で切れる (`finished with reason "length"`) ため、作問は要件定義の分野配分を保ったまま `KAKOMON_GENERATE_BATCH` 問 (既定 15) ずつのバッチで生成し、結合してから校閲する。ジョブ欄には「作問中 (2/6 バッチ目: 問16〜30)」のように出る。モデルが考えている間は「思考中 (要約 N 文字)」、書き出し中は「出力 N 文字」、過去問を参照中は「ツール get-past-exam を実行中」が更新される。思考の深さは `KAKOMON_GENERATE_EFFORT` (既定 `high`) で変えられる。校閲で指摘が出た場合は、指摘された設問だけを再出力して差し替える。バッチが 1 つ終わるごとに下書き (状態 `draft`) を保存するので、途中で失敗しても生成済みの設問は「3. 予想問題」の一覧に残る。校閲や改訂が失敗したときは、失敗の内容を注意書きに残して校閲前の内容のまま承認待ちに回す (トークンを使った成果を捨てない)。

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

## 費用とモデルの使い分け

全工程を Opus 5.5 で回すと費用がかさむため、工程ごとに「判断の質が結果を左右するか」「受験者数に比例して回数が増えるか」で分けている。設定はすべて `.env` で変えられる。

### 単価 (Anthropic API、2026-10-09 に https://platform.claude.com/docs/en/about-claude/pricing から取得)

| モデル | 入力 / 100万トークン | キャッシュ読み取り | 出力 / 100万トークン |
|---|---|---|---|
| Claude Opus 5.5 | $4 | $0.20 | $20 |
| Claude Sonnet 5.5 | $2 | $0.10 | $10 |
| Claude Haiku 5.5 (プロンプト 10 万トークン以下) | $0.10 | $0.01 | $0.50 |

ネット検索は別途 1,000 回あたり $10 (`webFetch` は無料)。

### 工程ごとの割り当て (既定)

| 工程 | モデル (環境変数) | 思考の深さ | 理由 |
|---|---|---|---|
| 取り込み (PDF → 設問 JSON) | Opus 5.5 (`KAKOMON_EXTRACT_MODEL`、未設定なら `KAKOMON_MODEL`) | medium | 1 試験につき 1 回。以降の全工程の元データになるので読み取りの質を優先。写真が鮮明なら Sonnet 5.5 でも足りる可能性が高く、半額になる |
| 傾向分析 (要件定義) | Opus 5.5 (`KAKOMON_MODEL`) | high | 1 試験セットにつき 1 回。作問の設計図なので質を優先 |
| 作問 (生成・改訂) | Opus 5.5 (`KAKOMON_MODEL`) | high (`KAKOMON_GENERATE_EFFORT`) | 成果物そのもの。xhigh は 1 バッチに数十分かかるので high を既定にした |
| 校閲 | Sonnet 5.5 (`KAKOMON_REVIEW_MODEL`) | medium | 要件定義・過去問との照合は検査作業。1 回分につき 1〜2 回 |
| 正解推定 (過去問に正解を付ける) | Opus 5.5 (`KAKOMON_MODEL` で上書き) | high | 採点の正解データになるので誤りが許されない。1 試験につき 1 回 |
| 添削の解説 | Sonnet 5.5 (`KAKOMON_LIGHT_MODEL`) | medium | **受験者の提出ごとに 1 回**。回数が最も増える工程なので単価を下げる。さらに安くするなら Haiku 5.5 |
| 弱点分析 | Sonnet 5.5 (`KAKOMON_LIGHT_MODEL`) | medium | 受験者ごと。入力は集計済みの小さな JSON |
| ジョブ開始前の疎通確認 | Haiku 5.5 (`KAKOMON_PREFLIGHT_MODEL`) | low | 16 トークンの ping。10 分キャッシュ |

### 1 回あたりの概算

トークン数は本番 DB の実データのサイズ (90 問の過去問 JSON ≒ 86KB) からの推定で、計測値ではない。実測するには Mastra の観測機能 (`mastra_ai_spans`) を有効にして `usage` を集計する。

| 工程 | 主な内訳 | 概算 |
|---|---|---|
| 取り込み 1 回 (90 問, 30 ページ) | PDF 入力 ~5 万 + 出力 ~4 万トークン | Opus: 約 $1.0 / Sonnet: 約 $0.5 |
| 傾向分析 1 回 | 過去問 JSON をツールで読む (ステップごとに再送) + 出力 ~1.5 万 | Opus: 約 $2〜4 |
| 作問 1 回 (90 問 = 6 バッチ) + 校閲 + 改訂 1 回 | バッチごとに過去問 JSON ~3.5 万トークンがステップごとに再送 + 出力 ~1.5 万 ×6 | Opus 作問 約 $6〜12 + Sonnet 校閲 約 $1 + 改訂 約 $2 = **約 $10〜15** |
| 正解推定 1 回 (90 問) | 入力 ~4 万 + 出力 ~2 万 | Opus: 約 $0.6 |
| 添削 1 回 (90 問の解説) | 入力 ~4 万 + 出力 ~1.5 万 | Opus なら約 $0.45 → **Sonnet: 約 $0.23** / Haiku: 約 $0.01 |
| 弱点分析 1 回 | 入力 ~1 万 + 出力 ~3 千 | Sonnet: 約 $0.05 |

つまり、作問は 1 回 $10 前後の固定費、添削は受験者 × 受験回数で積み上がる変動費。添削を Opus から Sonnet に変えると変動費が半分、Haiku なら 1/40 になる。

### さらに下げる余地 (未実装)

1. **ツール結果のキャッシュ**: 作問・分析では `get-past-exam` の結果 (~3.5 万トークン) が同じ実行内の全ステップで再送される。入力費の大半はここ。メッセージ単位のキャッシュ区切りを入れれば 2 ステップ目以降は 5% になる。
2. **ツール結果の軽量化**: 作問に必要なのは問題文・選択肢・分野・型で、`rationale` / `explanation` / `keywords` は不要なことが多い。`get-past-exam` に「要約モード」を足せば再送量そのものが減る。
3. **取り込みを Sonnet に**: `KAKOMON_EXTRACT_MODEL=anthropic/claude-sonnet-5-5`。読み取り品質を数回分確認してから切り替える。
4. **Batch API**: 急がない作問を 50% 引きで回せるが、ツール呼び出しのある多段ループは向かない。添削の夜間一括処理などに限られる。

## 8. よくある質問

- **Studio と CLI で DB が別になる** → `KAKOMON_DB_URL` を絶対パス (`file:/abs/path/kakomon.db`) にする。
- **PDF が出ない** → `playwright-core` と Chromium が必要。`pdfSkippedReason` に理由が入る。HTML は常に出る。`KAKOMON_CHROMIUM_PATH` で既存の Chrome を指せる。
- **生成が要件から外れる** → `docs/specs/<specId>.md` の分野名・比率・mustNot を見直し、`--instructions` で補足を渡す。校閲の `issues` を読むと原因が分かる。
- **弱点分析ができない** → 同じアカウントで 2 回以上提出が必要。
- **受験者がパスワードを忘れた** → `npm run admin -- user reset-password <username> <newPassword>`。
