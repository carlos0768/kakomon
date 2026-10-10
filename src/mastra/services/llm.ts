import type { Agent, AgentExecutionOptionsBase } from '@mastra/core/agent'
import type { MessageListInput } from '@mastra/core/agent/message-list'
import { JobCancelledError } from './job-progress.ts'

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
  /** ジョブの停止シグナル。abort されたらモデル呼び出しを打ち切って JobCancelledError を投げる */
  signal?: AbortSignal
}

/** structuredOutput 付きの stream オプション。スキーマの型は呼び出し側の parse に任せるので unknown */
export type StreamObjectOptions = AgentExecutionOptionsBase<unknown> & {
  structuredOutput: { schema: unknown; jsonPromptInjection?: boolean | 'auto'; model?: unknown }
  /** エージェント既定のモデルを呼び出し単位で上書きする (例: 校閲エージェントを正解推定では Opus で使う) */
  model?: string
}

export async function streamObject(
  agent: Agent,
  messages: MessageListInput,
  options: StreamObjectOptions,
  hooks: { progress?: StreamProgress; onText?: (text: string) => void } = {},
): Promise<unknown> {
  const signal = hooks.progress?.signal
  if (signal?.aborted) throw new JobCancelledError()
  try {
    return await consume(await agent.stream(messages, (signal ? { ...options, abortSignal: signal } : options) as never), hooks)
  } catch (err) {
    if (signal?.aborted) throw new JobCancelledError()
    throw err
  }
}

async function consume(stream: Awaited<ReturnType<Agent['stream']>>, hooks: { progress?: StreamProgress; onText?: (text: string) => void }): Promise<unknown> {
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
  if (hooks.progress?.signal?.aborted) throw new JobCancelledError()
  let obj: unknown
  try {
    obj = await stream.object
  } catch (err) {
    throw new Error(`構造化出力の検証に失敗しました: ${toError(err).message}${await describeStream(stream)}`)
  }
  if (obj === undefined || obj === null) {
    throw new Error(`構造化出力を取得できませんでした${await describeStream(stream)}`)
  }
  return obj
}

/** 失敗時の診断: 終了理由と出力の長さ。思考トークンも maxOutputTokens に含まれるため、length なら上限不足の可能性が高い */
async function describeStream(stream: { finishReason: Promise<string | undefined>; text: Promise<string> }): Promise<string> {
  const finishReason = await stream.finishReason.catch(() => undefined)
  const text = await stream.text.catch(() => '')
  const hint =
    finishReason === 'length'
      ? '。出力上限 (思考トークンを含む maxOutputTokens) に達して途中で切れました'
      : finishReason === 'tool-calls'
        ? '。ツール呼び出しの上限 (maxSteps) に達し、最終出力が書かれませんでした'
        : text.trim().length === 0
          ? '。モデルが本文を出力しませんでした'
          : '。出力が JSON として解釈できませんでした'
  return ` (finishReason=${finishReason ?? '不明'}, 出力 ${text.length.toLocaleString()} 文字${hint})`
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return new Error((err as { message: string }).message)
  }
  return new Error(typeof err === 'string' ? err : JSON.stringify(err))
}
