import type { Hono } from 'hono'
import { createAuth } from '../src/auth.ts'
import type { SqliteRepository } from '../src/storage/sqlite.ts'

export function makeAuth(repo: SqliteRepository) {
  return createAuth({ sqlite: repo.raw, users: repo, secret: 'test-secret', webOrigin: 'http://web.test', anonTtlDays: 7 })
}

export async function anonSession(app: Hono): Promise<string> {
  const res = await app.request('/api/auth/sign-in/anonymous', { method: 'POST', headers: { origin: 'http://web.test' } })
  if (res.status !== 200) throw new Error(`anon sign-in failed: ${res.status}`)
  const setCookie = res.headers.get('set-cookie') ?? ''
  return setCookie.split(';')[0] // "textcaster.session_token=..."
}

export async function registeredSession(app: Hono, email: string): Promise<string> {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test' },
    body: JSON.stringify({ email, password: 'password123', name: email }),
  })
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`)
  const setCookie = res.headers.get('set-cookie') ?? ''
  return setCookie.split(';')[0]
}
