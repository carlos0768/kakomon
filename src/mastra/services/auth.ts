import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { ensureSchema, getDb } from '../db/client.ts'

/**
 * 受験者アカウント: ユーザー名 + パスワードだけの簡易認証 (メール不要)。
 * - パスワードは scrypt でハッシュ化して保存
 * - セッションはランダムトークンを Cookie に入れ、DB には SHA-256 ハッシュだけ保存
 */

const scrypt = promisify(scryptCb)
export const SESSION_COOKIE = 'kakomon_session'
export const SESSION_TTL_DAYS = 30

export const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/
export const PASSWORD_MIN = 8

export interface User {
  id: string
  username: string
  createdAt: string
}

export class AuthError extends Error {
  constructor(
    message: string,
    public status: 400 | 401 | 409 = 400,
  ) {
    super(message)
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = (await scrypt(password, salt, 64)) as Buffer
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, keyB64] = stored.split('$')
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false
  const expected = Buffer.from(keyB64, 'base64')
  const actual = (await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length)) as Buffer
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function validate(username: string, password: string) {
  if (!USERNAME_RE.test(username)) throw new AuthError('ユーザー名は 3〜32 文字の英数字とアンダースコアにしてください')
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) throw new AuthError(`パスワードは ${PASSWORD_MIN} 文字以上にしてください`)
}

export async function registerUser(username: string, password: string): Promise<User> {
  await ensureSchema()
  validate(username, password)
  const existing = await getDb().execute('SELECT id FROM users WHERE username = ?', [username])
  if (existing[0]) throw new AuthError('そのユーザー名はすでに使われています', 409)
  const id = randomUUID()
  await getDb().execute('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)', [id, username, await hashPassword(password)])
  return (await getUserById(id))!
}

export async function authenticate(username: string, password: string): Promise<User> {
  await ensureSchema()
  const rows = await getDb().execute('SELECT id, username, password_hash, created_at FROM users WHERE username = ?', [username])
  const row = rows[0]
  if (!row || !(await verifyPassword(password, String(row.password_hash)))) {
    throw new AuthError('ユーザー名またはパスワードが違います', 401)
  }
  return { id: String(row.id), username: String(row.username), createdAt: String(row.created_at) }
}

export async function getUserById(id: string): Promise<User | undefined> {
  await ensureSchema()
  const rows = await getDb().execute('SELECT id, username, created_at FROM users WHERE id = ?', [id])
  const row = rows[0]
  return row ? { id: String(row.id), username: String(row.username), createdAt: String(row.created_at) } : undefined
}

export async function getUserByUsername(username: string): Promise<User | undefined> {
  await ensureSchema()
  const rows = await getDb().execute('SELECT id, username, created_at FROM users WHERE username = ?', [username])
  const row = rows[0]
  return row ? { id: String(row.id), username: String(row.username), createdAt: String(row.created_at) } : undefined
}

/** 管理者用: パスワードを強制的に再設定する (忘れたとき) */
export async function resetPassword(username: string, newPassword: string): Promise<void> {
  await ensureSchema()
  validate(username, newPassword)
  const user = await getUserByUsername(username)
  if (!user) throw new AuthError('ユーザーが見つかりません')
  await getDb().execute('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(newPassword), user.id])
  await getDb().execute('DELETE FROM sessions WHERE user_id = ?', [user.id])
}

export async function listUsers(): Promise<User[]> {
  await ensureSchema()
  const rows = await getDb().execute('SELECT id, username, created_at FROM users ORDER BY created_at ASC')
  return rows.map(r => ({ id: String(r.id), username: String(r.username), createdAt: String(r.created_at) }))
}

/** セッションを作り、Cookie に入れる生トークンを返す */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  await ensureSchema()
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
  await getDb().execute('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [hashToken(token), userId, expiresAt.toISOString()])
  return { token, expiresAt }
}

export async function getUserBySession(token: string | undefined): Promise<User | undefined> {
  if (!token) return undefined
  await ensureSchema()
  const rows = await getDb().execute(
    `SELECT u.id, u.username, u.created_at, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    [hashToken(token)],
  )
  const row = rows[0]
  if (!row) return undefined
  if (new Date(String(row.expires_at)).getTime() < Date.now()) {
    await deleteSession(token)
    return undefined
  }
  return { id: String(row.id), username: String(row.username), createdAt: String(row.created_at) }
}

export async function deleteSession(token: string | undefined): Promise<void> {
  if (!token) return
  await ensureSchema()
  await getDb().execute('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)])
}

// ---- Cookie ヘルパ (hono の cookie ユーティリティに依存しない最小実装) ----

export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return undefined
}

export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure ? '; Secure' : ''}`
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
}
