import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { ensureCoreUser } from '../src/api/auth.ts'
import { makeAuth, anonSession } from './auth-helper.ts'

async function makeApp() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const auth = makeAuth(repo)
  const app = createApp({ service, bus, token: 'secret', auth })
  return { app, repo, service, auth }
}

function anonAuthUserId(repo: Awaited<ReturnType<typeof createSqliteRepository>>): string {
  const row = repo.raw.prepare('SELECT id FROM user WHERE isAnonymous = 1').get() as { id: string } | undefined
  if (!row) throw new Error('no anonymous auth user row found')
  return row.id
}

test('anonymous sign-in mints a host-only session cookie', async () => {
  const { app } = await makeApp()
  const res = await app.request('/api/auth/sign-in/anonymous', { method: 'POST', headers: { origin: 'http://web.test' } })
  expect(res.status).toBe(200)
  const sc = res.headers.get('set-cookie') ?? ''
  expect(sc).toContain('textcaster.session_token=')
  expect(sc.toLowerCase()).not.toContain('domain=') // host-only (SEC-1)
  expect(sc.toLowerCase()).toContain('httponly')
  expect(sc.toLowerCase()).toContain('samesite=lax')
})

test('cookie without Origin is rejected by better-auth CSRF (probed MISSING_OR_NULL_ORIGIN)', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const res = await app.request('/api/auth/sign-out', { method: 'POST', headers: { cookie } })
  expect(res.status).toBe(403)
})

test('registration while anonymous re-points the guest core user (onLinkAccount)', async () => {
  const { app, repo } = await makeApp()
  const cookie = await anonSession(app)
  const anonAuthId = anonAuthUserId(repo)
  const guest = await ensureCoreUser(repo, anonAuthId)
  await repo.insertPost({
    id: 'guest-post', authorId: guest.id, source: 'local', guid: 'guest-post', title: null,
    content: 'guest content', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
  })

  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test', cookie },
    body: JSON.stringify({ email: 'a@b.example', password: 'password123', name: 'a' }),
  })
  expect(res.status).toBe(200)
  const newAuthId = (await res.json()).user.id as string

  const linked = await repo.getUserByAuthUserId(newAuthId)
  expect(linked?.id).toBe(guest.id) // same core identity, re-pointed
  expect(linked?.handle).toBe(guest.handle) // guest handle intact
  const guestPost = await repo.getPost('guest-post')
  expect(guestPost?.authorId).toBe(guest.id) // posts intact

  const remainingAnon = repo.raw.prepare('SELECT COUNT(*) AS n FROM user WHERE isAnonymous = 1').get() as { n: number }
  expect(remainingAnon.n).toBe(0) // anon auth row deleted by better-auth
})

test('login while anonymous abandons the guest core user (orphaned, reclaimed in Task 5)', async () => {
  const { app, repo } = await makeApp()

  // Register X in a fresh (non-anonymous) session, and establish X's core
  // user the way a real GET /me would lazily (Task 4 route, not wired yet).
  const signUp = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test' },
    body: JSON.stringify({ email: 'x@b.example', password: 'password123', name: 'x' }),
  })
  expect(signUp.status).toBe(200)
  const xAuthId = (await signUp.json()).user.id as string
  await ensureCoreUser(repo, xAuthId)

  // Now a separate anonymous session mints its own guest core user.
  const cookie = await anonSession(app)
  const anonAuthId = anonAuthUserId(repo)
  const guest = await ensureCoreUser(repo, anonAuthId)

  // That anonymous session logs in as X — onLinkAccount sees an existing
  // core user for X and abandons the guest instead of re-pointing it.
  const res = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test', cookie },
    body: JSON.stringify({ email: 'x@b.example', password: 'password123' }),
  })
  expect(res.status).toBe(200)

  const guestAfter = await repo.getUser(guest.id)
  expect(guestAfter?.authUserId).toBe(anonAuthId) // still points at the now-deleted anon auth row: orphaned
})
