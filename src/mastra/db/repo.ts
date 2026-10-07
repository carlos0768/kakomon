import { randomUUID } from 'node:crypto'
import { ensureSchema, getDb } from './client.ts'
import { extractedExamSchema, questionSchema, type ExtractedExam, type Question } from '../schemas/exam.ts'
import { examSpecSchema, type ExamSpec } from '../schemas/spec.ts'
import type { Answer, GradingResult, WeaknessReport } from '../schemas/grading.ts'

export type ExamKind = 'past' | 'predicted'
export type ExamStatus = 'draft' | 'review' | 'published' | 'archived'

export interface ExamRecord {
  id: string
  kind: ExamKind
  title: string
  year?: number
  session?: string
  status: ExamStatus
  sourceFile?: string
  specId?: string
  exam: ExtractedExam
  createdAt: string
  updatedAt: string
}

export interface SpecRecord {
  id: string
  title: string
  status: 'draft' | 'approved'
  spec: ExamSpec
  createdAt: string
  updatedAt: string
}

export interface AttemptRecord {
  id: string
  userId: string
  examId: string
  status: 'in_progress' | 'submitted'
  answers: Answer[]
  result?: GradingResult
  startedAt: string
  submittedAt?: string
}

function str(v: unknown): string | undefined {
  return v == null ? undefined : String(v)
}
function num(v: unknown): number | undefined {
  return v == null ? undefined : Number(v)
}

function rowToExam(row: Record<string, unknown>): ExamRecord {
  return {
    id: String(row.id),
    kind: row.kind as ExamKind,
    title: String(row.title),
    year: num(row.year),
    session: str(row.session),
    status: row.status as ExamStatus,
    sourceFile: str(row.source_file),
    specId: str(row.spec_id),
    exam: extractedExamSchema.parse(JSON.parse(String(row.data_json))),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

/** 設問の検索対象テキスト (キーワード検索用) */
export function questionSearchText(q: Question): string {
  return [q.passage ?? '', q.stem, ...q.choices.map(c => c.text), q.domain, q.topic, ...q.keywords].join('\n')
}

// ---------- exams ----------

export async function saveExam(input: {
  id?: string
  kind: ExamKind
  exam: ExtractedExam
  status?: ExamStatus
  sourceFile?: string
  specId?: string
}): Promise<ExamRecord> {
  await ensureSchema()
  const db = getDb()
  const id = input.id ?? randomUUID()
  const exam = extractedExamSchema.parse(input.exam)
  const tx = await db.transaction('write')
  try {
    await tx.execute({
      sql: `INSERT INTO exams (id, kind, title, year, session, status, source_file, spec_id, data_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, title=excluded.title, year=excluded.year,
              session=excluded.session, status=excluded.status, source_file=excluded.source_file,
              spec_id=excluded.spec_id, data_json=excluded.data_json, updated_at=datetime('now')`,
      args: [
        id,
        input.kind,
        exam.title,
        exam.year ?? null,
        exam.session ?? null,
        input.status ?? 'draft',
        input.sourceFile ?? null,
        input.specId ?? null,
        JSON.stringify(exam),
      ],
    })
    await tx.execute({ sql: 'DELETE FROM questions WHERE exam_id = ?', args: [id] })
    for (const q of exam.questions) {
      await tx.execute({
        sql: `INSERT INTO questions (exam_id, number, domain, topic, question_type, difficulty, cognitive_level, correct_label, search_text, data_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          q.number,
          q.domain,
          q.topic,
          q.questionType,
          q.difficulty,
          q.cognitiveLevel,
          q.correctLabel ?? null,
          questionSearchText(q),
          JSON.stringify(q),
        ],
      })
    }
    await tx.commit()
  } finally {
    tx.close()
  }
  return (await getExam(id))!
}

export async function getExam(id: string): Promise<ExamRecord | undefined> {
  await ensureSchema()
  const rs = await getDb().execute({ sql: 'SELECT * FROM exams WHERE id = ?', args: [id] })
  const row = rs.rows[0]
  return row ? rowToExam(row as unknown as Record<string, unknown>) : undefined
}

export async function listExams(filter: { kind?: ExamKind; status?: ExamStatus } = {}): Promise<ExamRecord[]> {
  await ensureSchema()
  const where: string[] = []
  const args: (string | number)[] = []
  if (filter.kind) {
    where.push('kind = ?')
    args.push(filter.kind)
  }
  if (filter.status) {
    where.push('status = ?')
    args.push(filter.status)
  }
  const rs = await getDb().execute({
    sql: `SELECT * FROM exams ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY year DESC, created_at DESC`,
    args,
  })
  return rs.rows.map(r => rowToExam(r as unknown as Record<string, unknown>))
}

export async function updateExamStatus(id: string, status: ExamStatus): Promise<void> {
  await ensureSchema()
  await getDb().execute({
    sql: `UPDATE exams SET status = ?, updated_at = datetime('now') WHERE id = ?`,
    args: [status, id],
  })
}

export async function deleteExam(id: string): Promise<void> {
  await ensureSchema()
  await getDb().execute({ sql: 'DELETE FROM questions WHERE exam_id = ?', args: [id] })
  await getDb().execute({ sql: 'DELETE FROM exams WHERE id = ?', args: [id] })
}

// ---------- questions ----------

export interface QuestionHit {
  examId: string
  examTitle: string
  year?: number
  question: Question
}

export async function searchQuestions(params: {
  keyword?: string
  domain?: string
  topic?: string
  questionType?: string
  examIds?: string[]
  kind?: ExamKind
  limit?: number
}): Promise<QuestionHit[]> {
  await ensureSchema()
  const where: string[] = []
  const args: (string | number)[] = []
  if (params.kind) {
    where.push('e.kind = ?')
    args.push(params.kind)
  }
  if (params.examIds?.length) {
    where.push(`q.exam_id IN (${params.examIds.map(() => '?').join(',')})`)
    args.push(...params.examIds)
  }
  if (params.domain) {
    where.push('q.domain LIKE ?')
    args.push(`%${params.domain}%`)
  }
  if (params.topic) {
    where.push('q.topic LIKE ?')
    args.push(`%${params.topic}%`)
  }
  if (params.questionType) {
    where.push('q.question_type = ?')
    args.push(params.questionType)
  }
  if (params.keyword) {
    // 空白区切りで AND 検索
    for (const kw of params.keyword.split(/\s+/).filter(Boolean)) {
      where.push('q.search_text LIKE ?')
      args.push(`%${kw}%`)
    }
  }
  const limit = Math.min(params.limit ?? 20, 100)
  const rs = await getDb().execute({
    sql: `SELECT q.exam_id, q.data_json, e.title, e.year FROM questions q JOIN exams e ON e.id = q.exam_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY e.year DESC, q.number ASC LIMIT ${limit}`,
    args,
  })
  return rs.rows.map(r => ({
    examId: String(r.exam_id),
    examTitle: String(r.title),
    year: num(r.year),
    question: questionSchema.parse(JSON.parse(String(r.data_json))),
  }))
}

/** 分野×トピック×設問型の出題数集計 (傾向分析の定量データ) */
export async function aggregateQuestions(examIds?: string[]): Promise<
  { examId: string; year?: number; domain: string; topic: string; questionType: string; difficulty: number; cognitiveLevel: string; count: number }[]
> {
  await ensureSchema()
  const where = examIds?.length ? `WHERE q.exam_id IN (${examIds.map(() => '?').join(',')})` : "WHERE e.kind = 'past'"
  const rs = await getDb().execute({
    sql: `SELECT q.exam_id, e.year, q.domain, q.topic, q.question_type, q.difficulty, q.cognitive_level, COUNT(*) AS cnt
          FROM questions q JOIN exams e ON e.id = q.exam_id ${where}
          GROUP BY q.exam_id, q.domain, q.topic, q.question_type, q.difficulty, q.cognitive_level
          ORDER BY e.year, q.domain, q.topic`,
    args: examIds?.length ? examIds : [],
  })
  return rs.rows.map(r => ({
    examId: String(r.exam_id),
    year: num(r.year),
    domain: String(r.domain),
    topic: String(r.topic),
    questionType: String(r.question_type),
    difficulty: Number(r.difficulty),
    cognitiveLevel: String(r.cognitive_level),
    count: Number(r.cnt),
  }))
}

// ---------- specs ----------

function rowToSpec(row: Record<string, unknown>): SpecRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    status: row.status as SpecRecord['status'],
    spec: examSpecSchema.parse(JSON.parse(String(row.data_json))),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export async function saveSpec(input: { id?: string; spec: ExamSpec; status?: SpecRecord['status'] }): Promise<SpecRecord> {
  await ensureSchema()
  const id = input.id ?? randomUUID()
  const spec = examSpecSchema.parse(input.spec)
  await getDb().execute({
    sql: `INSERT INTO specs (id, title, status, data_json) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET title=excluded.title, status=excluded.status, data_json=excluded.data_json, updated_at=datetime('now')`,
    args: [id, spec.title, input.status ?? 'draft', JSON.stringify(spec)],
  })
  return (await getSpec(id))!
}

export async function getSpec(id: string): Promise<SpecRecord | undefined> {
  await ensureSchema()
  const rs = await getDb().execute({ sql: 'SELECT * FROM specs WHERE id = ?', args: [id] })
  const row = rs.rows[0]
  return row ? rowToSpec(row as unknown as Record<string, unknown>) : undefined
}

export async function listSpecs(): Promise<SpecRecord[]> {
  await ensureSchema()
  const rs = await getDb().execute('SELECT * FROM specs ORDER BY created_at DESC')
  return rs.rows.map(r => rowToSpec(r as unknown as Record<string, unknown>))
}

// ---------- attempts ----------

function rowToAttempt(row: Record<string, unknown>): AttemptRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    examId: String(row.exam_id),
    status: row.status as AttemptRecord['status'],
    answers: JSON.parse(String(row.answers_json)),
    result: row.result_json ? JSON.parse(String(row.result_json)) : undefined,
    startedAt: String(row.started_at),
    submittedAt: str(row.submitted_at),
  }
}

export async function createAttempt(input: { userId: string; examId: string }): Promise<AttemptRecord> {
  await ensureSchema()
  const id = randomUUID()
  await getDb().execute({
    sql: 'INSERT INTO attempts (id, user_id, exam_id) VALUES (?, ?, ?)',
    args: [id, input.userId, input.examId],
  })
  return (await getAttempt(id))!
}

export async function getAttempt(id: string): Promise<AttemptRecord | undefined> {
  await ensureSchema()
  const rs = await getDb().execute({ sql: 'SELECT * FROM attempts WHERE id = ?', args: [id] })
  const row = rs.rows[0]
  return row ? rowToAttempt(row as unknown as Record<string, unknown>) : undefined
}

export async function submitAttempt(id: string, answers: Answer[], result: GradingResult): Promise<AttemptRecord> {
  await ensureSchema()
  await getDb().execute({
    sql: `UPDATE attempts SET status='submitted', answers_json=?, result_json=?, submitted_at=datetime('now') WHERE id = ?`,
    args: [JSON.stringify(answers), JSON.stringify(result), id],
  })
  return (await getAttempt(id))!
}

export async function listAttempts(userId: string, status?: AttemptRecord['status']): Promise<AttemptRecord[]> {
  await ensureSchema()
  const rs = await getDb().execute({
    sql: `SELECT * FROM attempts WHERE user_id = ? ${status ? 'AND status = ?' : ''} ORDER BY started_at ASC`,
    args: status ? [userId, status] : [userId],
  })
  return rs.rows.map(r => rowToAttempt(r as unknown as Record<string, unknown>))
}

// ---------- weakness reports ----------

export async function saveWeaknessReport(report: WeaknessReport): Promise<void> {
  await ensureSchema()
  await getDb().execute({
    sql: `INSERT INTO weakness_reports (user_id, data_json) VALUES (?, ?)
          ON CONFLICT(user_id) DO UPDATE SET data_json=excluded.data_json, updated_at=datetime('now')`,
    args: [report.userId, JSON.stringify(report)],
  })
}

export async function getWeaknessReport(userId: string): Promise<WeaknessReport | undefined> {
  await ensureSchema()
  const rs = await getDb().execute({ sql: 'SELECT data_json FROM weakness_reports WHERE user_id = ?', args: [userId] })
  const row = rs.rows[0]
  return row ? (JSON.parse(String(row.data_json)) as WeaknessReport) : undefined
}
