import { ModelRouterEmbeddingModel } from '@mastra/core/llm'
import { createTool } from '@mastra/core/tools'
import { LibSQLVector } from '@mastra/libsql'
import { PgVector } from '@mastra/pg'
import { createVectorQueryTool } from '@mastra/rag'
import { embedMany } from 'ai'
import { z } from 'zod'
import { config, pgSslOption } from '../config.ts'
import { resolvePassage, type ExtractedExam } from '../schemas/exam.ts'

/**
 * 任意機能: 埋め込みモデルが設定されていればベクトル検索を有効化する。
 * 過去問の規模 (数十〜数百問) ならキーワード検索で十分なことが多いので、
 * 既定では無効にし、EMBEDDING_MODEL を設定したときだけ使う。
 */

export const VECTOR_STORE_NAME = 'kakomonVector'
export const VECTOR_INDEX = 'past_questions'

/** DB 方言に合わせたベクトルストア (Postgres なら pgvector、それ以外は libSQL) */
export const vectorStore =
  config.dbDialect === 'postgres'
    ? new PgVector({ id: VECTOR_STORE_NAME, connectionString: config.dbUrl, ssl: pgSslOption(config.dbUrl), max: config.isServerless ? 2 : 10 })
    : new LibSQLVector({ id: VECTOR_STORE_NAME, url: config.dbUrl, authToken: config.dbAuthToken })

export function isVectorSearchEnabled(): boolean {
  return Boolean(config.embeddingModel)
}

function embeddingModel() {
  if (!config.embeddingModel) throw new Error('EMBEDDING_MODEL is not set')
  return new ModelRouterEmbeddingModel(config.embeddingModel as `${string}/${string}`)
}

/** 過去問 1 回分の設問を埋め込みしてインデックスに投入する */
export async function indexExamForVectorSearch(examId: string, exam: ExtractedExam): Promise<number> {
  if (!isVectorSearchEnabled()) return 0
  const values = exam.questions.map(q =>
    [resolvePassage(q, exam.passages) ?? '', q.stem, ...q.choices.map(c => `${c.label}. ${c.text}`)].filter(Boolean).join('\n'),
  )
  const { embeddings } = await embedMany({ model: embeddingModel(), values })
  const dimension = embeddings[0]?.length
  if (!dimension) return 0
  await vectorStore.createIndex({ indexName: VECTOR_INDEX, dimension })
  await vectorStore.upsert({
    indexName: VECTOR_INDEX,
    vectors: embeddings,
    ids: exam.questions.map(q => `${examId}:${q.number}`),
    metadata: exam.questions.map((q, i) => ({
      examId,
      number: q.number,
      domain: q.domain,
      topic: q.topic,
      questionType: q.questionType,
      text: values[i],
    })),
  })
  return embeddings.length
}

/** 意味検索ツール (有効時のみエージェントに渡す) */
export function createSemanticSearchTool() {
  if (!isVectorSearchEnabled()) {
    return createTool({
      id: 'semantic-search-past-questions',
      description: '意味的に近い過去問設問を探す (現在は無効。search-past-questions を使うこと)',
      inputSchema: z.object({ queryText: z.string() }),
      outputSchema: z.object({ relevantContext: z.array(z.unknown()) }),
      execute: async () => ({ relevantContext: [] }),
    })
  }
  return createVectorQueryTool({
    id: 'semantic-search-past-questions',
    description: '意味的に近い過去問設問を探す。言い回しが違う類題の検出や、分野横断の出題例探しに使う。',
    vectorStoreName: VECTOR_STORE_NAME,
    indexName: VECTOR_INDEX,
    model: embeddingModel(),
    enableFilter: true,
  })
}
