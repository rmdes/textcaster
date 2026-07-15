import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'

async function setup() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  return { repo, bus, svc: createService(repo, bus) }
}

test('createLocalPost stores, emits, and appears in the timeline', async () => {
  const { bus, svc } = await setup()
  await svc.addRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' }) // remote coexists
  const seen = vi.fn()
  bus.onNewPost(seen)
  await svc.createLocalPostAs('alice', 'Alice', 'hello world')
  expect(seen).toHaveBeenCalledTimes(1)
  const tl = await svc.getTimeline()
  expect(tl.map((e) => e.content)).toContain('hello world')
  expect(tl[0].author.kind).toBe('local')
})
