import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.ts'
import { deleteExam, getExam, listSpecs } from '../db/repo.ts'
import { isVectorSearchEnabled, vectorStore, VECTOR_INDEX } from '../tools/vector-search.ts'
import { findRunningJob } from './jobs.ts'

/**
 * 登録済みの過去問の削除。
 * 設問・ベクトル索引・管理画面からアップロードした PDF の控えをまとめて消す。
 * 要件定義は自己完結しているので残す (元の過去問は一覧で「(削除済み)」と表示される)。
 */

/** 管理画面のアップロードで付く保存名 (`<ミリ秒>-<8 桁の16進>-...`)。CLI で指定した元の PDF は消さないための目印 */
const UPLOADED_NAME = /^\d{13}-[0-9a-f]{8}-/

/** 削除してよいか。読み書き中のジョブがあれば理由を返す (削除すると途中のジョブが壊れるか、消した過去問を保存し直してしまう) */
export async function deleteBlockReason(examId: string): Promise<string | undefined> {
  const sameExam = (j: { input: unknown }) => (j.input as { examId?: string }).examId === examId
  if ((await findRunningJob('solve', sameExam)) ?? (await findRunningJob('answers', sameExam)))
    return 'この過去問の正解推定・正解インポートが実行中です。終わってから削除してください'
  if (await findRunningJob('ingest', sameExam)) return 'この過去問の取り込みが実行中です。終わってから削除してください'
  const analyzing = await findRunningJob('analyze', j => {
    const ids = (j.input as { examIds?: string[] }).examIds
    return !ids?.length || ids.includes(examId)
  })
  if (analyzing) return 'この過去問を対象にした傾向分析が実行中です。終わってから削除してください'
  const sources = new Map((await listSpecs()).map(sp => [sp.id, sp.spec.sourceExamIds]))
  const generating = await findRunningJob('generate', j => {
    const input = j.input as { specId?: string; referenceExamId?: string }
    return input.referenceExamId === examId || Boolean(input.specId && sources.get(input.specId)?.includes(examId))
  })
  if (generating) return 'この過去問を参照する作問が実行中です。終わってから削除してください'
  return undefined
}

export interface DeleteExamResult {
  examId: string
  title: string
  /** 削除した過去問を分析対象に含んでいた要件定義 (残っている) */
  specIds: string[]
  /** 後始末で気づいた点 (ベクトル索引・PDF の削除失敗など。削除自体は完了している) */
  notes: string[]
}

/** 過去問を削除する。存在しなければ undefined、過去問でなければ例外 */
export async function deletePastExam(examId: string): Promise<DeleteExamResult | undefined> {
  const rec = await getExam(examId)
  if (!rec) return undefined
  if (rec.kind !== 'past') throw new Error('削除できるのは過去問だけです。予想問題は「非公開」にしてください')

  await deleteExam(examId)
  const notes: string[] = []

  if (isVectorSearchEnabled()) {
    try {
      await vectorStore.deleteVectors({ indexName: VECTOR_INDEX, ids: rec.exam.questions.map(q => `${examId}:${q.number}`) })
    } catch (err) {
      notes.push(`ベクトル索引から設問を消せませんでした: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const file = rec.sourceFile ? path.resolve(rec.sourceFile) : undefined
  if (file && path.dirname(file) === path.resolve(config.uploadDir) && UPLOADED_NAME.test(path.basename(file))) {
    try {
      await unlink(file)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        notes.push(`アップロードした PDF を消せませんでした (${file}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const specIds = (await listSpecs()).filter(s => s.spec.sourceExamIds.includes(examId)).map(s => s.id)
  return { examId, title: rec.title, specIds, notes }
}
