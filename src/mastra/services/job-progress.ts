import type { RequestContext } from '@mastra/core/request-context'
import { ensureSchema, getDb } from '../db/client.ts'

/**
 * 実行中ジョブの進捗。ワークフローのステップから書き込み、管理画面が 5 秒ごとに読む。
 * jobs.ts と workflows の循環参照を避けるため、DB 直接アクセスだけのモジュールにしている。
 */

/** workflow の requestContext にジョブ ID を載せるときのキー */
export const JOB_ID_KEY = 'kakomon.jobId'

export interface JobProgress {
  /** 何をしている段階か (例: "PDF を読み取り中", "設問を保存中") */
  phase: string
  /** モデルが出力した文字数 (進んでいる証拠として表示する) */
  outputChars?: number
  /** 補足 (例: "設問 12 件まで出力") */
  note?: string
  /** 書き込み時刻 (ISO)。古ければ「応答なし」と判断する */
  at: string
}

export function jobIdFrom(requestContext?: RequestContext): string | undefined {
  const v = requestContext?.get(JOB_ID_KEY as never)
  return typeof v === 'string' ? v : undefined
}

export async function reportJobProgress(jobId: string | undefined, progress: Omit<JobProgress, 'at'>): Promise<void> {
  if (!jobId) return
  await ensureSchema()
  const p: JobProgress = { ...progress, at: new Date().toISOString() }
  await getDb()
    .execute(`UPDATE jobs SET progress_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'`, [JSON.stringify(p), jobId])
    .catch(() => undefined)
}

/**
 * 進捗の書き込みを間引くヘルパ。`tick()` を好きな頻度で呼んでよく、
 * 前回の書き込みから intervalMs 以上たったときだけ DB に書く。`flush()` で即時書き込み。
 */
export function progressReporter(jobId: string | undefined, phase: string, intervalMs = 5000) {
  let last = 0
  let chars = 0
  let note: string | undefined
  let pending: Promise<void> = Promise.resolve()
  const write = () => {
    last = Date.now()
    pending = reportJobProgress(jobId, { phase, outputChars: chars, note })
    return pending
  }
  return {
    /** 出力文字が増えたときに呼ぶ */
    tick(deltaChars: number, newNote?: string) {
      chars += deltaChars
      if (newNote) note = newNote
      if (Date.now() - last >= intervalMs) void write()
    },
    setPhase(next: string, newNote?: string) {
      phase = next
      note = newNote
      return write()
    },
    flush: () => write(),
    get outputChars() {
      return chars
    },
  }
}
