import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, anonSession } from './auth-helper.ts'

async function makeApp() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  return createApp({ service: createService(repo, bus), bus, token: 'secret', auth: makeAuth(repo), users: repo })
}
const patch = (cookie: string, content: string) => ({ method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content }) })

test('returns current post + revisions oldest-first (public, no auth)', async () => {
  const app = await makeApp()
  const cookie = await anonSession(app)
  const pid = (await (await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'v1' }) })).json()).post.id
  await app.request(`/posts/${pid}`, patch(cookie, 'v2'))
  await app.request(`/posts/${pid}`, patch(cookie, 'v3'))
  const res = await app.request(`/posts/${pid}/revisions`) // no cookie → public
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.post.content).toBe('v3')
  expect(body.revisions.map((r: { content: string }) => r.content)).toEqual(['v1', 'v2'])
})

test('unknown post → 404', async () => {
  expect((await (await makeApp()).request('/posts/nope/revisions')).status).toBe(404)
})
