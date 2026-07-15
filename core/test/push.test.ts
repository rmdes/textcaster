import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createPush } from '../src/domain/push.ts'
import { loadConfig } from '../src/config.ts'

const EXT_ENV = { TEXTCASTER_TOKEN: 't', TEXTCASTER_PUBLIC_URL: 'https://cast.example.com', TEXTCASTER_WEBSUB: 'https://hub.example.com/hub' }

async function setup(env: Record<string, string>) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const config = loadConfig(env)
  return { repo, bus, service, config }
}

test('external mode publishes a ping per topic on a local post', async () => {
  const { repo, service, config } = await setup(EXT_ENV)
  const fetchFn = vi.fn(async () => new Response('ok', { status: 204 }))
  const push = createPush({ repo, config, fetchFn: fetchFn as unknown as typeof fetch })
  const entry = await service.createLocalPostAs('alice', 'Alice', 'ping-worthy')
  await push.onLocalPost(entry)
  expect(fetchFn).toHaveBeenCalledTimes(2)
  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://hub.example.com/hub')
  const params = new URLSearchParams(init.body as string)
  expect(params.get('hub.mode')).toBe('publish')
  expect(params.get('hub.topic')).toBe('https://cast.example.com/users/alice/feed.xml')
  expect(params.get('hub.url')).toBe(params.get('hub.topic'))
})

test('remote posts and websub-off both produce no pings', async () => {
  const { repo, service, config } = await setup(EXT_ENV)
  const fetchFn = vi.fn(async () => new Response('ok'))
  const push = createPush({ repo, config, fetchFn: fetchFn as unknown as typeof fetch })
  const remote = await service.addRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://news.example.com/f.xml' })
  await push.onLocalPost({ id: 'x', authorId: remote.id, source: 'remote', guid: 'g', title: null, content: 'c', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', author: remote })
  expect(fetchFn).not.toHaveBeenCalled()

  const off = await setup({ TEXTCASTER_TOKEN: 't' })
  const offPush = createPush({ repo: off.repo, config: off.config, fetchFn: fetchFn as unknown as typeof fetch })
  const entry = await off.service.createLocalPostAs('bob', 'Bob', 'silent')
  await offPush.onLocalPost(entry)
  expect(fetchFn).not.toHaveBeenCalled()
})

test('onLocalPost never rejects, even when fetch explodes (H4)', async () => {
  const { repo, service, config } = await setup(EXT_ENV)
  const fetchFn = vi.fn(async () => { throw new Error('network down') })
  const push = createPush({ repo, config, fetchFn: fetchFn as unknown as typeof fetch })
  const entry = await service.createLocalPostAs('alice', 'Alice', 'doomed ping')
  await expect(push.onLocalPost(entry)).resolves.toBeUndefined()
})
