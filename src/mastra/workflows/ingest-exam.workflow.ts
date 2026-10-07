import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { anthropicOptions } from '../config.ts'
import { saveExam } from '../db/repo.ts'
import { extractedExamSchema } from '../schemas/exam.ts'
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
  execute: async ({ inputData, mastra }) => {
    const abs = path.resolve(inputData.filePath)
    const pdf = await readFile(abs)
    const agent = mastra.getAgentById('exam-extractor')
    const hints = [
      inputData.title && `試験名: ${inputData.title}`,
      inputData.year && `年度: ${inputData.year}`,
      inputData.session && `回次: ${inputData.session}`,
    ].filter(Boolean)
    const result = await agent.generate(
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
        modelSettings: { maxOutputTokens: 64000 },
        providerOptions: anthropicOptions('high'),
      },
    )
    const exam = extractedExamSchema.parse(result.object)
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
  execute: async ({ inputData }) => {
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
