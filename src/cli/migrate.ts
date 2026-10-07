#!/usr/bin/env node
/**
 * KAKOMON_DB_URL が指す DB にアプリのテーブルを作成する (冪等)。
 * Supabase では supabase/migrations/*.sql を Supabase CLI で適用してもよいし、このコマンドでもよい。
 * Mastra 自身のテーブル (mastra_*) はサーバ初回起動時に PostgresStore が作成する。
 *
 *   npm run db:migrate
 */
import { config } from '../mastra/config.ts'
import { ensureSchema, getDb } from '../mastra/db/client.ts'

const redacted = config.dbUrl.replace(/:\/\/([^:@/]+)(:[^@/]*)?@/, '://$1:***@')
console.log(`migrating ${config.dbDialect} database: ${redacted}`)
await ensureSchema()
const db = getDb()
const rows = await db.execute(
  db.dialect === 'postgres'
    ? "SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() ORDER BY 1"
    : "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY 1",
)
console.log('tables:', rows.map(r => r.name).join(', '))
await db.close()
