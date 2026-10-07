# AI エージェント基盤の選定

## 結論

**Mastra (TypeScript) + Claude Opus 5.5** を採用する。

| 項目 | 採用 |
|---|---|
| エージェント基盤 | `@mastra/core` 1.75 系 (Agent / Tool / Workflow / RAG / Storage / Studio) |
| LLM | Claude Opus 5.5 (`anthropic/claude-opus-5-5`)。Mastra の model router 経由で公式 `@ai-sdk/anthropic` が使われる |
| 永続化 | 開発は libSQL (SQLite ファイル 1 つ)、本番は Supabase (PostgreSQL, `@mastra/pg`)。同じコードが両方で動く |
| ベクトル検索 | 任意。`EMBEDDING_MODEL` を設定したときのみ `LibSQLVector` を使う (Voyage / OpenAI / Cohere / Google の埋め込みに対応) |
| 見た目の再現 | レイアウトプロファイル → HTML/CSS → Chromium (playwright-core) で PDF |

## 要件から導いた評価軸

この案件で基盤に求められるのは次の 5 点。

1. **ワークフロー (決まった手順) と エージェント (自律的な参照) の両方**
   取り込み → 分析 → 生成 → 校閲 → 承認 → 出力 は手順が固定なのでワークフロー。一方、作問者が「どの過去問を何問読むか」は固定できないので、ツール付きエージェントに任せたい。
2. **人間 (管理者) の承認ゲート**
   予想問題を作る主体は管理者なので、「LLM が生成 → 管理者が確認 → 公開」の間で処理を止めて、後から再開できる必要がある (suspend / resume)。
3. **過去問へのアクセス手段**
   プロンプトに過去問を全部貼るのは、量・コスト・精度の面で限界がある。LLM が自分で検索・取得できるツール (キーワード検索 / 設問取得 / 統計) と、必要に応じたベクトル検索。
4. **構造化出力**
   設問・選択肢・正解・分野・難易度を JSON で確実に受け取る。
5. **TypeScript / Web との親和性**
   サイト (管理者 UI・受験者 UI) に組み込む前提。Next.js や Hono に乗せられること。

## 候補比較

| 候補 | 1. WF+Agent | 2. 承認ゲート | 3. 過去問アクセス | 4. 構造化出力 | 5. TS/Web | 所感 |
|---|---|---|---|---|---|---|
| **Mastra** | ◎ 両方が一級市民 | ◎ `suspend()`/`resume()` がストレージ永続化付きで組み込み | ◎ `createTool` + RAG (`@mastra/rag`, vector stores) | ◎ `structuredOutput` (Zod) | ◎ TS ネイティブ、Studio (ローカル管理画面) 付き | 今回の要件にほぼそのまま一致 |
| Vercel AI SDK 単体 | △ ループは自前 | × 自前実装 | △ ツールは書けるが RAG/永続化は無い | ◎ | ◎ | 「エンジン」であって「車」ではない。Mastra の下回りに使われている |
| LangGraph.js | ◎ グラフで明示制御 | ◎ interrupt | ○ LangChain 経由 | ○ | △ Python 版が先行、API が TS として重い | 機能は十分だが学習コスト・記述量が大きい |
| OpenAI Agents SDK | ○ | ○ | ○ | ◎ | ○ | OpenAI モデル前提。Claude を主モデルにしたい本件とは合わない |
| Claude Managed Agents | ◎ (Anthropic がループとサンドボックスを運用) | ○ (`tool_confirmation`) | ○ (自作ツール / MCP) | ◎ | △ | 強力だがベータで、DB を持つ Web アプリの一部として組み込むには重い。将来の選択肢 |
| Claude API Tool Runner / 手書きループ | △ | × | △ | ◎ | ◎ | 依存が最小で済むが、ワークフロー永続化・承認・Studio を全部自作することになる |

## Mastra を選ぶ決め手

- **承認ゲートが標準機能**: `generate-exam` ワークフローの `admin-approval` ステップは `suspend()` で止まり、Studio / CLI / HTTP のどこからでも `resume()` できる。状態は libSQL に保存されるので、プロセスを再起動しても続きから進められる。
- **ツール経由の過去問参照**: `list-past-exams` / `get-past-exam` / `search-past-questions` / `get-question-stats` / `get-exam-spec` を作問 LLM・校閲 LLM・分析 LLM が共有する。「プロンプトだけでは再現が厳しい」問題に対する直接の答え。
- **Studio**: `npm run dev` で http://localhost:4111 に管理画面が立ち、各エージェント・ワークフローを GUI で試せる。管理者が作問を回すのに十分。
- **差し替え容易**: モデルは文字列 1 つ (`KAKOMON_MODEL`)、DB は `LibSQLStore` → `PostgresStore` の置換で済む。

## Claude 側の設定方針

- 既定モデルは Claude Opus 5.5。思考は常時 ON なので深さは `effort` で制御する (作問: `xhigh`、分析・抽出・校閲: `high`、添削・コーチ: `medium`)。
- `fallbacks: 'default'` を全呼び出しに付け、安全分類器による拒否時はサーバ側で別モデルにフォールバックする。
- PDF は Claude のネイティブ PDF 入力 (最大 32MB / 600 ページ) で読む。写真を束ねた PDF でもそのまま扱える。
- 構造化出力は Mastra の `structuredOutput` に `jsonPromptInjection: 'auto'` を指定し、ツール併用時も安定させる。

## 参考 (調査時点のソース)

- Mastra 1.0 リリースと機能概要: https://www.producthunt.com/products/mastra/launches/mastra-1-0 、 https://thenewstack.io/mastra-empowers-web-devs-to-build-ai-agents-in-typescript/
- 比較記事: https://particula.tech/blog/mastra-vs-langgraph-vs-vercel-ai-sdk-typescript-agents 、 https://www.speakeasy.com/blog/ai-agent-framework-comparison 、 https://www.firecrawl.dev/blog/best-open-source-agent-frameworks 、 https://www.ayautomate.com/blog/best-typescript-ai-agent-frameworks
- AI SDK Anthropic provider (adaptive thinking / effort): https://ai-sdk.dev/providers/ai-sdk-providers/anthropic
- API 仕様は npm に同梱の `@mastra/core/dist/docs/` (公式ドキュメントのオフライン版) で確認した。
