import type { Agent, AgentExecutionOptionsBase } from '@mastra/core/agent'
import type { MessageListInput } from '@mastra/core/agent/message-list'

/**
 * 長い出力を伴うエージェント呼び出しの共通ヘルパ。
 *
 * `agent.generate()` は非ストリーミング (HTTP の応答ヘッダが出力完了まで返らない) のため、
 * 出力に 5 分以上かかると Node の fetch が "headers timeout after 300000" で切ってしまう。
 * `agent.stream()` なら先頭からチャンクが流れるので時間制限に当たらず、進捗も取れる。
 * 構造化出力は最後に `stream.object` で受け取る (スキーマ検証はこの関数の外で行う)。
 */

export interface StreamProgress {
  /** 出力文字が増えたとき・ツールが呼ばれたときに呼ばれる (DB への書き込みは呼び出し側で間引く) */
  tick(deltaChars: number, note?: string): void
}

/** structuredOutput 付きの stream オプション。スキーマの型は呼び出し側の parse に任せるので unknown */
export type StreamObjectOptions = AgentExecutionOptionsBase<unknown> & {
  structuredOutput: { schema: unknown; jsonPromptInjection?: boolean | 'auto'; model?: unknown }
}

export async function streamObject(
  agent: Agent,
  messages: MessageListInput,
  options: StreamObjectOptions,
  hooks: { progress?: StreamProgress; onText?: (text: string) => void } = {},
): Promise<unknown> {
  const stream = await agent.stream(messages, options as never)
  let reasoningChars = 0
  for await (const chunk of stream.fullStream) {
    if (chunk.type === 'text-delta') {
      hooks.onText?.(chunk.payload.text)
      hooks.progress?.tick(chunk.payload.text.length)
    } else if (chunk.type === 'reasoning-delta') {
      // 思考 (要約) が流れている間も「生きている」ことを進捗に出す。出力文字数には数えない
      reasoningChars += chunk.payload.text.length
      hooks.progress?.tick(0, `思考中 (要約 ${reasoningChars.toLocaleString()} 文字)`)
    } else if (chunk.type === 'tool-call') {
      hooks.progress?.tick(0, `ツール ${chunk.payload.toolName} を実行中`)
    } else if (chunk.type === 'error') {
      throw toError(chunk.payload.error)
    } else {
      // それ以外のチャンク (step-start, tool-result, finish など) も接続が生きている証拠として扱う
      hooks.progress?.tick(0)
    }
  }
  return await stream.object
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return new Error((err as { message: string }).message)
  }
  return new Error(typeof err === 'string' ? err : JSON.stringify(err))
}
