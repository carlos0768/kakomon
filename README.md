# kakomon — 過去問分析 → 予想問題生成 → LLM 添削 → 弱点分析

過去問 PDF を読み込んで出題傾向と作問方法を分析し、**出題要件定義** を作る。その定義をもとに、過去問にツールでアクセスできる作問 LLM が予想問題を生成し、管理者が承認したものだけを、原本と同じ見た目 (HTML/PDF) で受験者に公開する。受験者は選択肢を選ぶだけ。提出すると LLM が「選んだ選択肢がなぜ誤りか」を解説し、2 回以上解くと弱点分析ができる。

- 基盤: [Mastra](https://mastra.ai) (TypeScript エージェント/ワークフロー) + Claude Opus 5.5
- 選定理由: [docs/01_framework-selection.md](docs/01_framework-selection.md)
- 要件定義: [docs/02_requirements-definition.md](docs/02_requirements-definition.md)
- 設計: [docs/03_architecture.md](docs/03_architecture.md)
- 管理者手順: [docs/04_admin-runbook.md](docs/04_admin-runbook.md)

## クイックスタート

```bash
npm install
cp .env.example .env          # ANTHROPIC_API_KEY を設定
npm run admin -- ingest data/past-exams/2024.pdf --year 2024   # 過去問を登録 (複数年度)
npm run admin -- analyze --title "○○試験"                       # 出題要件定義を生成 → docs/specs/<specId>.md
npm run admin -- generate --spec <specId> --title "予想問題 第1回"   # 作問 → 校閲 → 承認待ち
npm run admin -- approve <runId>                                 # 承認 → data/out/<examId>.html/.pdf → 公開
npm run dev                                                      # Studio: http://localhost:4111 / 受験者UI: /kakomon
```

## 処理の流れ

| 段階 | 主体 | 実体 |
|---|---|---|
| 過去問 PDF → 構造化 (設問・正解・分野・難易度・レイアウト) | 管理者 | `ingest-exam` ワークフロー |
| 傾向分析 → 出題要件定義 | 管理者 | `analyze-exam` ワークフロー (分析 LLM が過去問ツールを使う) |
| 予想問題生成 → 校閲 → 承認 → HTML/PDF 出力 → 公開 | 管理者 | `generate-exam` ワークフロー (承認待ちで suspend) |
| 解答 → 添削 (正誤はコード、解説は LLM) | 受験者 | `grade-attempt` ワークフロー |
| 2 回以上の結果 → 弱点分析 (集計はコード、原因と計画は LLM) | 受験者 | `weakness-analysis` ワークフロー |

## 開発

```bash
npm run typecheck   # tsc
npm test            # vitest (決定的ロジック + モック LLM の結合テスト)
```
