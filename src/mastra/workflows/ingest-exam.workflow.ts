import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { anthropicOptions } from '../config.ts'
import { saveExam } from '../db/repo.ts'
import { extractedExamSchema } from '../schemas/exam.ts'
import { jobIdFrom, progressReporter } from '../services/job-progress.ts'
import { streamObject } from '../services/llm.ts'
import { indexExamForVectorSearch } from '../tools/vector-search.ts'

/**
 * 過去問 PDF の取り込み: PDF → 構造化 → DB 保存 (+ ベクトル索引)。
 * 管理者が事前に送っておく「写真を束ねた PDF」をそのまま入力にできる。
 */

const inputSchema = z.object({
  filePath: z.string().describe('過去問 PDF のパス'),
  kind: z.enum(['past', 'predicted']).default('past'),
  title: z.string().optional().describe('試験名 (PDF から読み取れない場合の補助)'),
  year: z.number().int().optional(),
  session: z.string().optional(),
  examId: z.string().optional().describe('再取り込み時に上書きする ID'),
})

const extractStep = createStep({
  id: 'extract-pdf',
  inputSchema,
  outputSchema: z.object({
    input: inputSchema,
    exam: extractedExamSchema,
  }),
  execute: async ({ inputData, mastra, requestContext }) => {
    const abs = path.resolve(inputData.filePath)
    const pdf = await readFile(abs)
    const agent = mastra.getAgentById('exam-extractor')
    const progress = progressReporter(jobIdFrom(requestContext), 'PDF をモデルに送信中')
    await progress.flush()
    const hints = [
      inputData.title && `試験名: ${inputData.title}`,
      inputData.year && `年度: ${inputData.year}`,
      inputData.session && `回次: ${inputData.session}`,
    ].filter(Boolean)
    // 出力が長い (数万トークン) ので stream で受け、進捗 (出力文字数・設問数) を jobs に書く。
    // 転記作業なので思考は medium で十分。巨大な PDF を何度も再送しないよう再試行は 1 回まで。
    let started = false
    let questionCount = 0
    const raw = await streamObject(
      agent,
      [
        {
          role: 'user',
          content: [
            { type: 'file', data: pdf, mediaType: 'application/pdf', filename: path.basename(abs) },
            {
              type: 'text',
              text: `この PDF の過去問をすべて構造化してください。${hints.length ? `\n補足情報:\n${hints.join('\n')}` : ''}`,
            },
          ],
        },
      ],
      {
        structuredOutput: { schema: extractedExamSchema, jsonPromptInjection: 'auto' },
        modelSettings: { maxOutputTokens: 64000, maxRetries: 1 },
        providerOptions: anthropicOptions('medium'),
      },
      {
        progress,
        onText: text => {
          if (!started) {
            started = true
            void progress.setPhase('設問を読み取り中').catch(() => undefined) // 停止済みなら直後の streamObject が止める
          }
          // "number": が出るたびに設問 1 件分が始まったとみなす (目安)
          const n = (text.match(/"number"\s*:/g) ?? []).length
          if (n) {
            questionCount += n
            progress.tick(0, `設問 ${questionCount} 件目まで出力`)
          }
        },
      },
    )
    await progress.setPhase('読み取り結果を検証中', `${progress.outputChars.toLocaleString()} 文字`)
    const exam = extractedExamSchema.parse(raw)
    // passageId が passages に無い設問は参照を外して注意として残す
    const ids = new Set(exam.passages.map(p => p.id))
    for (const q of exam.questions) {
      if (q.passageId && !ids.has(q.passageId)) {
        exam.extractionNotes.push(`問${q.number}: 資料文 ${q.passageId} が見つからない`)
        q.passageId = undefined
      }
    }
    if (inputData.title) exam.title = inputData.title
    if (inputData.year) exam.year = inputData.year
    if (inputData.session) exam.session = inputData.session
    return { input: inputData, exam }
  },
})

const saveStep = createStep({
  id: 'save-exam',
  inputSchema: extractStep.outputSchema,
  outputSchema: z.object({
    examId: z.string(),
    title: z.string(),
    questionCount: z.number().int(),
    answeredCount: z.number().int(),
    indexedVectors: z.number().int(),
    extractionNotes: z.array(z.string()),
  }),
  execute: async ({ inputData, requestContext }) => {
    const progress = progressReporter(jobIdFrom(requestContext), '設問を保存中')
    await progress.flush()
    const rec = await saveExam({
      id: inputData.input.examId,
      kind: inputData.input.kind,
      exam: inputData.exam,
      status: 'published',
      sourceFile: path.resolve(inputData.input.filePath),
    })
    const indexedVectors = await indexExamForVectorSearch(rec.id, rec.exam)
    return {
      examId: rec.id,
      title: rec.title,
      questionCount: rec.exam.questions.length,
      answeredCount: rec.exam.questions.filter(q => q.correctLabel).length,
      indexedVectors,
      extractionNotes: rec.exam.extractionNotes,
    }
  },
})

export const ingestExamWorkflow = createWorkflow({
  id: 'ingest-exam',
  description: '過去問 PDF を読み取り、設問を構造化して DB に登録する',
  inputSchema,
  outputSchema: saveStep.outputSchema,
})
  .then(extractStep)
  .then(saveStep)
  .commit()
