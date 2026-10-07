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
| `exam-extractor` | `KAKOMON_MODEL`, effort high | なし (PDF を直接読む) | `ExtractedExam` |
| `exam-analyst` | `KAKOMON_MODEL`, effort high, maxSteps 40 | list / get / stats / search | `ExamSpec` |
| `exam-generator` | `KAKOMON_MODEL`, effort xhigh, maxSteps 60 | spec / list / get / search / semantic | `generatedExam` (questions + designNotes) |
| `exam-reviewer` | `KAKOMON_MODEL`, effort high | spec / search / get | `ReviewResult` |
| `exam-grader` | `KAKOMON_LIGHT_MODEL`, effort medium | なし | 解説バッチ |
| `exam-coach` | `KAKOMON_LIGHT_MODEL`, effort medium | なし | coaching |

「LLM に任せるもの」と「コードで決めるもの」を分けている。正誤判定・比率集計・優先度計算・レイアウト組版はコード、言語化と判断は LLM。

## データモデル (libSQL)

| テーブル | 主な列 | 用途 |
|---|---|---|
| `exams` | id, kind(past/predicted), title, year, status(draft/review/published/archived), spec_id, data_json | 過去問・予想問題の本体 (`ExtractedExam` を JSON で保持) |
| `questions` | exam_id, number, domain, topic, question_type, difficulty, cognitive_level, correct_label, search_text, data_json | 検索・集計用に設問を展開 |
| `specs` | id, title, status, data_json | 出題要件定義 |
| `attempts` | id, user_id, exam_id, status, answers_json, result_json | 受験と添削結果 |
| `weakness_reports` | user_id, data_json | 最新の弱点分析 |

Mastra 自身のテーブル (ワークフロー snapshot, トレース等) も同じ DB に作られる。`KAKOMON_DB_URL` が `postgresql://` なら Postgres (Supabase: `PostgresStore` / `PgVector` / `pg`)、それ以外なら libSQL (`LibSQLStore` / `LibSQLVector` / `@libsql/client`) を使う。SQL は `src/mastra/db/client.ts` のアダプタで両方言に対応しており、Postgres 用のマイグレーションは `supabase/migrations/` にある。

## HTTP API

Mastra 標準の `/api/*` (agents / workflows / Studio) に加えて、独自ルートを提供する。

### 受験者向け (正解を返さない)

| Method | Path | 内容 |
|---|---|---|
| GET | `/kakomon` | 最小 UI |
| GET | `/kakomon/exams` | 公開中の予想問題一覧 |
| GET | `/kakomon/exams/:examId` | 問題本文 (選択肢のラベル・本文のみ) |
| GET | `/kakomon/exams/:examId/print` | 原本の見た目を再現した印刷用 HTML |
| POST | `/kakomon/attempts` `{userId, examId}` | 受験開始 |
| POST | `/kakomon/attempts/:id/submit` `{answers:[{questionNumber, selectedLabel}]}` | 提出 → 添削結果 |
| GET | `/kakomon/attempts/:id` | 添削結果の再取得 |
| GET | `/kakomon/users/:userId/attempts` | 履歴と弱点分析可否 |
| POST/GET | `/kakomon/users/:userId/weakness` | 弱点分析の実行 / 最新結果 |

### 管理者向け (`KAKOMON_ADMIN_TOKEN` 設定時は `Authorization: Bearer`)

| Method | Path | 内容 |
|---|---|---|
| GET | `/kakomon/admin/specs` | 要件定義一覧 |
| GET | `/kakomon/admin/exams` | 全試験 (状態つき) |
| POST | `/kakomon/admin/runs/:runId/approve` `{approved, note?}` | 承認待ち生成ワークフローの再開 |
| POST | `/kakomon/admin/exams/:examId/status` `{status}` | 公開/非公開の切替 |

作問・分析の起動は Studio (`/api/workflows/*`) か CLI から行う。

## 既知の制約と拡張ポイント

- **図版**: 図や表を含む設問の見た目再現は未対応 (テキストのみ)。
- **認証**: 受験者 ID は自己申告。管理者側は `KAKOMON_ADMIN_TOKEN` による `SimpleAuth` で保護 (Studio・`/api/*`・`/kakomon/admin/*`)。受験者にもログインを付けるなら Mastra の auth (Supabase/Clerk など) に差し替える。
- **デプロイ**: Vercel は `docs/05_vercel-deployment.md`。DB は Supabase (PostgreSQL)、PDF 生成と取り込みは手元の CLI。
- **UI**: `/kakomon` は参照実装。Next.js へ移す場合は `src/mastra` をそのまま置き、Route Handler から `mastra.getWorkflow(...)` を呼ぶ (Mastra 公式の Next.js ガイドに準拠)。
- **ベクトル検索**: 既定は無効。過去問が数百問を超える、または言い回しの違う類題検出を強化したい場合に `EMBEDDING_MODEL` を設定する。
- **コスト**: 1 回分の生成は 作問 (xhigh, 数十ステップ) + 校閲 + 改訂 で Opus 5.5 を複数回呼ぶ。試算は Studio のトレースで `usage` を確認する。
