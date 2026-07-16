import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'

async function instance(publicUrl: string | null) {
  const repo = await createSqliteRepository(':memory:')
  const service = createService(repo, createEventBus())
  const app = createApp({ service, bus: createEventBus(), token: 'secret', feeds: { publicUrl, hubUrl: null, rssCloud: false } })
  return { repo, service, app }
}
const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' }

test('OPML round-trip: instance 1 export → instance 2 import recreates remote follows', async () => {
  const one = await instance('https://one.example')
  await one.repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  await one.service.addRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  await one.service.addRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://ex.com/b.xml' })
  await one.app.request('/users/alice/follows', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'news' }) })
  await one.app.request('/users/alice/follows', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'blog' }) })

  const opml = await (await one.app.request('/users/alice/following.opml')).text()

  const two = await instance('https://two.example')
  await two.repo.createLocalUser({ handle: 'importer', displayName: 'Importer' })
  const res = await two.app.request('/users/importer/follows/opml', { method: 'POST', headers: { authorization: 'Bearer secret' }, body: opml })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ followed: 2, created: 2, skipped: 0 })

  const list = await (await two.app.request('/users/importer/follows')).json()
  expect(list.following.map((u: { feedUrl: string }) => u.feedUrl).sort()).toEqual(['https://ex.com/b.xml', 'https://ex.com/f.xml'])
})
