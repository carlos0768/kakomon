import { beforeEach, describe, expect, it } from 'vitest'
import { resetDbForTests } from '../src/mastra/db/client.ts'
import { createAttempt, listAttempts } from '../src/mastra/db/repo.ts'
import { saveExam } from '../src/mastra/db/repo.ts'
import {
  AuthError,
  authenticate,
  clearSessionCookie,
  createSession,
  deleteSession,
  getUserBySession,
  hashPassword,
  readCookie,
  registerUser,
  resetPassword,
  sessionCookie,
  verifyPassword,
} from '../src/mastra/services/auth.ts'
import { makeExam } from './fixtures.ts'

describe('auth', () => {
  beforeEach(async () => {
    await resetDbForTests()
  })

  it('hashes passwords with scrypt and verifies them', async () => {
    const h = await hashPassword('correct horse')
    expect(h.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('correct horse', h)).toBe(true)
    expect(await verifyPassword('wrong', h)).toBe(false)
    expect(await verifyPassword('x', 'garbage')).toBe(false)
  })

  it('registers, rejects duplicates and bad input, and authenticates', async () => {
    const u = await registerUser('taro_1', 'password123')
    expect(u.username).toBe('taro_1')
    await expect(registerUser('taro_1', 'password123')).rejects.toMatchObject({ status: 409 })
    await expect(registerUser('ab', 'password123')).rejects.toBeInstanceOf(AuthError)
    await expect(registerUser('hanako', 'short')).rejects.toBeInstanceOf(AuthError)
    await expect(registerUser('太郎', 'password123')).rejects.toBeInstanceOf(AuthError)
    expect((await authenticate('taro_1', 'password123')).id).toBe(u.id)
    await expect(authenticate('taro_1', 'nope')).rejects.toMatchObject({ status: 401 })
    await expect(authenticate('nobody', 'password123')).rejects.toMatchObject({ status: 401 })
  })

  it('creates cookie sessions that resolve to the user, and logout/reset invalidates them', async () => {
    const u = await registerUser('taro', 'password123')
    const s = await createSession(u.id)
    expect((await getUserBySession(s.token))?.id).toBe(u.id)
    expect(await getUserBySession('not-a-token')).toBeUndefined()
    expect(await getUserBySession(undefined)).toBeUndefined()

    const cookie = sessionCookie(s.token, s.expiresAt, true)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(readCookie(`foo=bar; kakomon_session=${encodeURIComponent(s.token)}`, 'kakomon_session')).toBe(s.token)
    expect(clearSessionCookie(false)).toContain('Max-Age=0')

    await deleteSession(s.token)
    expect(await getUserBySession(s.token)).toBeUndefined()

    const s2 = await createSession(u.id)
    await resetPassword('taro', 'newpassword1')
    expect(await getUserBySession(s2.token)).toBeUndefined()
    expect((await authenticate('taro', 'newpassword1')).id).toBe(u.id)
  })

  it('ties attempts to the account id', async () => {
    const u = await registerUser('taro', 'password123')
    const exam = await saveExam({ kind: 'predicted', exam: makeExam(), status: 'published' })
    await createAttempt({ userId: u.id, examId: exam.id })
    expect(await listAttempts(u.id)).toHaveLength(1)
    expect(await listAttempts('someone-else')).toHaveLength(0)
  })
})
