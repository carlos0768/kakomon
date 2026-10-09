import type { Mastra } from '@mastra/core'
import { RequestContext } from '@mastra/core/request-context'
import { z } from 'zod'
import { anthropicOptions, config } from '../config.ts'
import { getExam, listExams, saveExam, getSpec } from '../db/repo.ts'
import { renderExamFiles } from '../render/pdf.ts'
import { passageSchema, questionSchema, type ExtractedExam } from '../schemas/exam.ts'
import { setExamScope } from './exam-scope.ts'
import { JOB_ID_KEY, progressReporter } from './job-progress.ts'
import { streamObject } from './llm.ts'

/**
 * 管理者のプロンプト (自然文の指示) で、承認前の予想問題を編集する。
 *
 * 全体を再出力させると出力上限に当たるうえ、指示と関係ない設問まで書き換わるおそれがあるため、
 * LLM には「変更・追加する設問と資料文、削除する番号」だけを差分として出させ、
 * それを applyExamEdit (LLM を呼ばない決定的ロジック) で当てはめる。
 */

export const examEditSchema = z.object({
  /** 変更・追加する設問。既存と同じ number なら差し替え、無い number なら追加 */
  questions: z.array(questionSchema).default([]).describe('変更・追加する設問だけ (変更しない設問は出力しない)'),
  /** 削除する設問番号 (編集前の番号) */
  removeQuestionNumbers: z.array(z.number().int()).default([]).describe('削除する設問の番号 (編集前の番号)'),
  /** 変更・追加する資料文。既存と同じ id なら差し替え */
  passages: z.array(passageSchema).default([]).describe('変更・追加する共有資料文だけ'),
  removePassageIds: z.array(z.string()).default([]).describe('削除する共有資料文の id'),
  title: z.string().optional().describe('タイトルを変える場合のみ'),
  instructions: z.array(z.string()).optional().describe('受験上の注意を変える場合のみ (全文)'),
  timeLimitMinutes: z.number().int().optional().describe('制限時間を変える場合のみ'),
  /** 何をどう変えたか (管理者向けの変更履歴) */
  summary: z.string().describe('何をどう変えたかの要約 (管理者向け)'),
})
export type ExamEdit = z.infer<typeof examEditSchema>

export interface ExamEditResult {
  exam: ExtractedExam
  /** 当てはめで気づいた点 (無視した指示・不整合の警告など) */
  notes: string[]
  /** 編集後の番号で、差し替え・追加された設問 */
  changedNumbers: number[]
  removedCount: number
}

/**
 * 差分を当てはめる。順序: 削除 → 差し替え/追加 → 番号順に並べて 1 から振り直し → 資料文の整合。
 * 元の exam は変更しない。
 */
export function applyExamEdit(original: ExtractedExam, patch: ExamEdit): ExamEditResult {
  const notes: string[] = []
  const exam: ExtractedExam = structuredClone(original)
  if (patch.title?.trim()) exam.title = patch.title.trim()
  if (patch.instructions) exam.instructions = patch.instructions
  if (patch.timeLimitMinutes !== undefined) exam.timeLimitMinutes = patch.timeLimitMinutes

  const remove = new Set(patch.removeQuestionNumbers)
  for (const n of remove) if (!original.questions.some(q => q.number === n)) notes.push(`削除指定の問${n} は存在しないため無視`)
  // 並べ替え用のキー (編集前の番号)。追加された設問は指定された number の位置に入る
  const keyed = exam.questions.filter(q => !remove.has(q.number)).map(q => ({ key: q.number, changed: false, q }))
  for (const q of patch.questions) {
    const i = keyed.findIndex(k => k.key === q.number)
    if (i >= 0) keyed[i] = { key: q.number, changed: true, q }
    else keyed.push({ key: q.number, changed: true, q })
  }
  // 同じ key は「既存 → 追加」の順 (sort は安定)
  keyed.sort((a, b) => a.key - b.key)
  exam.questions = keyed.map((k, i) => ({ ...k.q, number: i + 1 }))
  const changedNumbers = keyed.flatMap((k, i) => (k.changed ? [i + 1] : []))
  if (exam.questions.length === 0) throw new Error('編集の結果、設問が 0 問になります。全問削除はできません')

  const removePassages = new Set(patch.removePassageIds)
  exam.passages = exam.passages.filter(p => !removePassages.has(p.id))
  for (const p of patch.passages) {
    const i = exam.passages.findIndex(x => x.id === p.id)
    if (i >= 0) exam.passages[i] = p
    else exam.passages.push(p)
  }
  for (const q of exam.questions) {
    if (q.passageId && !exam.passages.some(p => p.id === q.passageId)) {
      notes.push(`問${q.number}: 資料文 ${q.passageId} が見つからないため参照を外した`)
      q.passageId = undefined
    }
    if (q.correctLabel && !q.choices.some(c => c.label === q.correctLabel)) {
      notes.push(`問${q.number}: 正解ラベル ${q.correctLabel} が選択肢にありません。確認してください`)
    }
  }
  const removedCount = original.questions.filter(q => remove.has(q.number)).length
  return { exam, notes, changedNumbers, removedCount }
}

/** 編集できる状態か。公開中は受験中・採点済みの解答と食い違うので、非公開にしてから編集する */
export function editBlockReason(rec: { kind: string; status: string } | undefined): string | undefined {
  if (!rec) return '予想問題が見つかりません'
  if (rec.kind !== 'predicted') return '編集できるのは予想問題だけです'
  if (rec.status === 'published') return '公開中の予想問題は編集できません (受験者の解答・採点と食い違うため)。非公開にしてから編集してください'
  return undefined
}

export async function editExamWithPrompt(mastra: Mastra, examId: string, prompt: string, jobId?: string) {
  const progress = progressReporter(jobId, '編集の準備中')
  await progress.flush()
  const rec = await getExam(examId)
  const blocked = editBlockReason(rec)
  if (blocked || !rec) throw new Error(blocked)

  // 作問と同じく、ツールで読める過去問を要件定義の元の過去問 + 同じ要件定義の予想問題に限定する
  const requestContext = new RequestContext()
  if (jobId) requestContext.set(JOB_ID_KEY as never, jobId as never)
  const spec = rec.specId ? await getSpec(rec.specId) : undefined
  if (spec) {
    const siblings = (await listExams({ kind: 'predicted' })).filter(e => e.specId === rec.specId).map(e => e.id)
    setExamScope(requestContext, [...new Set([...spec.spec.sourceExamIds, ...siblings])])
  }

  await progress.setPhase('指示に沿って編集中')
  const raw = await streamObject(
    mastra.getAgentById('exam-generator'),
    `作成済みの予想問題「${rec.exam.title}」を、管理者の指示に従って編集してください。

<管理者の指示>
${prompt}
</管理者の指示>

編集のルール:
- 指示に関係する設問・資料文だけを変更する。指示と関係のない設問は出力しない (出力しなかった設問はそのまま残る)
- 設問を差し替えるときは、編集前と同じ number で questions に全項目 (選択肢・correctLabel・すべての選択肢の rationale・domain などのタグ) を書く
- 設問を削除するときは removeQuestionNumbers に編集前の番号を書く。設問を追加するときは、現在の最大の番号 + 1 から順に number を付ける (末尾に追加される。番号は保存時に 1 から振り直す)
- 正解は必ず 1 つに定まり、すべての選択肢に rationale を付ける。選択肢ラベルの表記は既存の設問と揃える
- 資料文 (passages) を直す場合は同じ id で出力する
- タイトル・受験上の注意・制限時間は、指示があるときだけ出力する
- summary に、何をどう変えたかを日本語で簡潔に書く
- 出力は questions / removeQuestionNumbers / passages / removePassageIds / title / instructions / timeLimitMinutes / summary の JSON のみ
${rec.specId ? `- 要件定義 specId=${rec.specId} は get-exam-spec で読める。過去問は get-past-exam / search-past-questions で参照してよい\n` : ''}
現在の予想問題 (JSON):
${JSON.stringify({ title: rec.exam.title, instructions: rec.exam.instructions, timeLimitMinutes: rec.exam.timeLimitMinutes, passages: rec.exam.passages, questions: rec.exam.questions })}`,
    {
      requestContext,
      structuredOutput: { schema: examEditSchema, jsonPromptInjection: true },
      maxSteps: 40,
      modelSettings: { maxOutputTokens: 64000 },
      providerOptions: anthropicOptions(config.generateEffort),
    },
    { progress },
  )
  const patch = examEditSchema.parse(raw)
  const result = applyExamEdit(rec.exam, patch)

  await progress.setPhase('編集結果を保存中')
  const date = new Date().toISOString().slice(0, 10)
  result.exam.extractionNotes = [
    ...result.exam.extractionNotes,
    `[プロンプト編集 ${date}] 指示: ${prompt} / 変更: ${patch.summary}`,
    ...result.notes.map(n => `[プロンプト編集 ${date}] ${n}`),
  ]
  // 最新の状態を読み直してから保存する (編集中に承認・却下された場合に状態を巻き戻さない)
  const latest = await getExam(examId)
  const stillBlocked = editBlockReason(latest)
  if (stillBlocked || !latest) throw new Error(`編集中に状態が変わったため保存しませんでした: ${stillBlocked}`)
  await saveExam({ id: rec.id, kind: rec.kind, exam: result.exam, status: latest.status, sourceFile: rec.sourceFile, specId: rec.specId })
  // 管理者が確認する解答付きプレビュー (data/out) も更新する。失敗しても編集結果は保存済み
  await renderExamFiles(rec.id, result.exam, { withAnswers: true }).catch(() => undefined)

  return {
    examId: rec.id,
    summary: patch.summary,
    changedNumbers: result.changedNumbers,
    removedCount: result.removedCount,
    questionCount: result.exam.questions.length,
    notes: result.notes,
  }
}
