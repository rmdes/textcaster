import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'

async function makeApp() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret' })
  return { app, repo, service }
}
const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' }

test('follow requires the bearer token', async () => {
  const { app, repo } = await makeApp()
  await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  const res = await app.request('/users/alice/follows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'x' }) })
  expect(res.status).toBe(401)
})

test('follow, list, and unfollow round-trip', async () => {
  const { app, repo } = await makeApp()
  await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  const f = await app.request('/users/alice/follows', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'news' }) })
  expect(f.status).toBe(200)
  const list = await (await app.request('/users/alice/follows')).json()
  expect(list.following.map((u: { handle: string }) => u.handle)).toEqual(['news'])
  const d = await app.request('/users/alice/follows/news', { method: 'DELETE', headers: auth })
  expect(d.status).toBe(200)
  const d2 = await app.request('/users/alice/follows/news', { method: 'DELETE', headers: auth }) // idempotent
  expect(d2.status).toBe(200)
})

test('follow errors: 404 unknown handle, 400 non-local follower', async () => {
  const { app, repo } = await makeApp()
  await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  expect((await app.request('/users/alice/follows', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'ghost' }) })).status).toBe(404)
  expect((await app.request('/users/news/follows', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'alice' }) })).status).toBe(400)
})

test('lens query params: both → 400 before resolution, unknown → 404, author lens works', async () => {
  const { app, repo } = await makeApp()
  const x = await repo.createRemoteUser({ handle: 'x', displayName: 'X', feedUrl: 'https://ex.com/x.xml' })
  await repo.insertPost({ id: 'x1', authorId: x.id, source: 'remote', guid: 'x1', title: null, content: 'x1', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  expect((await app.request('/timeline?followed_by=ghost&author=alsoghost')).status).toBe(400) // both, even with unknown handles
  expect((await app.request('/timeline?author=ghost')).status).toBe(404)
  const lens = await (await app.request('/timeline?author=x')).json()
  expect(lens.timeline.map((e: { id: string }) => e.id)).toEqual(['x1'])
})
