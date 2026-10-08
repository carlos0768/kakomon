# アーキテクチャ

## 全体像

```
                    管理者 (CLI / Mastra Studio / 管理者 API)
                                   │
   data/past-exams/*.pdf ──► [ingest-exam] ──► exams/questions (libSQL) ──► (任意) LibSQLVector
                                   │                     ▲      ▲
                                   ▼                     │      │ tools
                            [analyze-exam] ──► specs ────┼──────┤  list-past-exams / get-past-exam /
                                   │                     │      │  search-past-questions / get-question-stats /
                                   ▼                     │      │  get-exam-spec / semantic-search
                            [generate-exam]              │      │
                 generate ─► review ─► (改訂) ─► 下書き保存 ─► preview HTML
                                   │
                        ── admin-approval (suspend) ──  ← 管理者が resume (approved=true/false)
                                   │
                        render-and-publish ─► data/out/<id>.html / .pdf, status=published
                                   │
                    受験者 (ブラウザ: /kakomon, API: /kakomon/*)
                                   │
                 attempts ─► [grade-attempt] (コードで採点 → LLM が解説) ─► 添削結果
                                   │
          2 回以上 ─► [weakness-analysis] (コードで集計 → LLM が原因・学習計画) ─► weakness_reports
```

## ディレクトリ

```
src/mastra/
  index.ts                 Mastra インスタンス (agents / workflows / storage / vectors / server.apiRoutes)
  config.ts                環境変数, Anthropic providerOptions (adaptive thinking, effort, fallbacks)
  schemas/                 Zod スキーマ (exam / spec / grading) — LLM 出力と DB の契約
  db/                      libSQL クライアント, DDL, リポジトリ関数
  tools/                   過去問アクセスツール, (任意) ベクトル検索
  agents/                  extractor / analyst / generator / reviewer / grader / coach
  workflows/               ingest / analyze / generate / grade / weakness
  services/                決定的ロジック (採点, 弱点集計, 要件定義の Markdown 化)
  render/                  レイアウトプロファイル → HTML, Chromium → PDF
  server/                  受験者 API・管理者 API・最小 UI
src/cli/admin.ts           管理者 CLI
test/                      vitest (決定的ロジック + モック LLM での結合テスト)
docs/                      本ドキュメント, docs/specs/ に要件定義の Markdown
data/past-exams/           管理者が置く過去問 PDF (git 管理外)
data/out/                  生成物 (git 管理外)
```

## エージェントと役割分担

| エージェント | モデル設定 | ツール | 出力 |
|---|---|---|---|
| `exam-extractor` | `KAKOMON_EXTRACT_MODEL` (既定 `KAKOMON_MODEL`), effort medium, stream | なし (PDF を直接読む) | `ExtractedExam` (共有資料文は `passages`、設問は `passageId` で参照) |
| `exam-analyst` | `KAKOMON_MODEL`, effort high, maxSteps 40 | list / get / stats / search / webSearch / webFetch | `ExamSpec` (参照した出典は `sources`) |
| `exam-generator` | `KAKOMON_MODEL`, effort xhigh, maxSteps 60 | spec / list / get / search / semantic / webSearch / webFetch | `generatedExam` (questions + designNotes) |
| `exam-reviewer` | `KAKOMON_MODEL`, effort high | spec / search / get / webSearch / webFetch | `ReviewResult` |
| `exam-grader` | `KAKOMON_LIGHT_MODEL`, effort medium | なし | 解説バッチ |
| `exam-coach` | `KAKOMON_LIGHT_MODEL`, effort medium | なし | coaching |

`webSearch` は Anthropic のサーバー側ウェブ検索 (Mastra の `webSearchTool` がモデル提供元に合わせて解決する)、`webFetch` は Mastra 内蔵の URL 取得。公開されている出題傾向の分析・公式の出題範囲・法令の最新情報を補助的に使い、登録された過去問の実データを優先する。`KAKOMON_WEB_SEARCH=0` で無効化。

「LLM に任せるもの」と「コードで決めるもの」を分けている。正誤判定・比率集計・優先度計算・レイアウト組版はコード、言語化と判断は LLM。

## データモデル (libSQL)

| テーブル | 主な列 | 用途 |
|---|---|---|
| `exams` | id, kind(past/predicted), title, year, status(draft/review/published/archived), spec_id, data_json | 過去問・予想問題の本体 (`ExtractedExam` を JSON で保持) |
| `questions` | exam_id, number, domain, topic, question_type, difficulty, cognitive_level, correct_label, search_text, data_json | 検索・集計用に設問を展開 |
| `specs` | id, title, status, data_json | 出題要件定義 |
| `attempts` | id, user_id, exam_id, status, answers_json, result_json | 受験と添削結果 |
| `weakness_reports` | user_id, data_json | 最新の弱点分析 |
| `users` | id, username (unique), password_hash (scrypt) | 受験者アカウント (メール不要) |
| `sessions` | token_hash, user_id, expires_at | Cookie セッション (生トークンは保存しない) |
| `jobs` | id, kind, status, run_id, input_json, result_json, suspend_json, progress_json, error | 管理画面から起動した非同期ジョブ (取り込み/分析/作問/正解推定)。progress_json は実行中の段階・出力文字数 |

Mastra 自身のテーブル (ワークフロー snapshot, トレース等) も同じ DB に作られる。`KAKOMON_DB_URL` が `postgresql://` なら Postgres (Supabase: `PostgresStore` / `PgVector` / `pg`)、それ以外なら libSQL (`LibSQLStore` / `LibSQLVector` / `@libsql/client`) を使う。SQL は `src/mastra/db/client.ts` のアダプタで両方言に対応しており、Postgres 用のマイグレーションは `supabase/migrations/` にある。

## HTTP API

Mastra 標準の `/api/*` (agents / workflows / Studio) に加えて、独自ルートを提供する。

### 受験者向け (正解を返さない)

アカウントはユーザー名 + パスワードのみ (メール不要)。ログインすると `kakomon_session` Cookie (HttpOnly, 30 日) が発行され、受験・履歴・弱点分析はその本人に限定される。

| Method | Path | 内容 |
|---|---|---|
| GET | `/kakomon` | 最小 UI (登録/ログイン画面つき) |
| POST | `/kakomon/auth/register` `{username, password}` | 登録 (英数字 3〜32 文字 / 8 文字以上) → そのままログイン |
| POST | `/kakomon/auth/login` `{username, password}` | ログイン |
| POST | `/kakomon/auth/logout` | ログアウト |
| GET | `/kakomon/auth/me` | ログイン中のユーザー |
| GET | `/kakomon/exams` | 公開中の予想問題一覧 |
| GET | `/kakomon/exams/:examId` | 問題本文 (選択肢のラベル・本文のみ) |
| GET | `/kakomon/exams/:examId/print` | 原本の見た目を再現した印刷用 HTML |
| POST | `/kakomon/attempts` `{examId}` | 受験開始 (要ログイン) |
| POST | `/kakomon/attempts/:id/submit` `{answers:[{questionNumber, selectedLabel}]}` | 提出 → 添削結果 (本人のみ) |
| GET | `/kakomon/attempts/:id` | 添削結果の再取得 (本人のみ) |
| GET | `/kakomon/me/attempts` | 自分の履歴と弱点分析可否 |
| POST/GET | `/kakomon/me/weakness` | 自分の弱点分析の実行 / 最新結果 |

### 管理者向け (`KAKOMON_ADMIN_TOKEN` 設定時は `Authorization: Bearer`)

管理画面 `/kakomon/admin` (静的 1 ページ) がこれらを呼ぶ。重い処理は **ジョブ** (`jobs` テーブル) としてバックグラウンド実行し、画面は 5 秒ごとにポーリングする。

| Method | Path | 内容 |
|---|---|---|
| GET | `/kakomon/admin/whoami` | トークン確認と環境情報 |
| GET | `/kakomon/admin/exams` | 全試験 (状態・設問数・正解の有無) |
| GET | `/kakomon/admin/exams/:examId/preview` | 正解・根拠つきプレビュー HTML (`?answers=0` で正解なし) |
| POST | `/kakomon/admin/exams/:examId/status` `{status}` | 公開/非公開の切替 |
| POST | `/kakomon/admin/exams/:examId/solve` | 正解推定ジョブを開始 |
| POST | `/kakomon/admin/upload` (multipart: file, title, year, session) | PDF を保存して取り込みジョブを開始 |
| GET | `/kakomon/admin/specs` / `/kakomon/admin/specs/:id/markdown` | 要件定義一覧 / Markdown |
| POST | `/kakomon/admin/analyze` `{title?, focus?, examIds?}` | 傾向分析ジョブを開始 |
| POST | `/kakomon/admin/generate` `{specId, title, referenceExamId?, questionCount?, instructions?}` | 作問ジョブを開始 (承認待ちで止まる) |
| GET | `/kakomon/admin/jobs` / `/kakomon/admin/jobs/:id` | ジョブ一覧 / 詳細 |
| POST | `/kakomon/admin/jobs/:id/approve` `{approved, note?}` | 承認待ちの作問ジョブを再開 (公開 or 却下) |
| GET | `/kakomon/admin/users` / POST `/kakomon/admin/users/:username/reset-password` | 受験者一覧 / パスワード再設定 |
| POST | `/kakomon/admin/runs/:runId/approve` | 互換: CLI と同じ runId ベースの承認 |

Studio (`/api/workflows/*`) と CLI からも同じワークフローを起動できる。

## 既知の制約と拡張ポイント

- **図版**: 図や表を含む設問の見た目再現は未対応 (テキストのみ)。
- **認証**: 受験者はユーザー名 + パスワードの簡易アカウント (scrypt ハッシュ + Cookie セッション、メール不要、身内向け)。パスワードを忘れた場合は管理者が `npm run admin -- user reset-password` で再設定する。管理者側は `KAKOMON_ADMIN_TOKEN` による `SimpleAuth` で保護 (Studio・`/api/*`・`/kakomon/admin/*`)。
- **デプロイ**: Vercel は `docs/05_vercel-deployment.md`。DB は Supabase (PostgreSQL)、PDF 生成と取り込みは手元の CLI。
- **UI**: `/kakomon` は参照実装。Next.js へ移す場合は `src/mastra` をそのまま置き、Route Handler から `mastra.getWorkflow(...)` を呼ぶ (Mastra 公式の Next.js ガイドに準拠)。
- **ベクトル検索**: 既定は無効。過去問が数百問を超える、または言い回しの違う類題検出を強化したい場合に `EMBEDDING_MODEL` を設定する。
- **コスト**: 1 回分の生成は 作問 (xhigh, 数十ステップ) + 校閲 + 改訂 で Opus 5.5 を複数回呼ぶ。試算は Studio のトレースで `usage` を確認する。
