import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { ingestRemoteUser } from '../src/domain/ingest.ts'

test('the loop closes: instance B ingests instance A user as a remote over plain RSS', async () => {
  // Instance A: emits alice's feed
  const repoA = await createSqliteRepository(':memory:')
  const busA = createEventBus()
  const serviceA = createService(repoA, busA)
  const appA = createApp({ service: serviceA, bus: busA, token: 'a', feeds: { publicUrl: 'http://a.example', hubUrl: null, rssCloud: false } })
  await serviceA.createLocalPostAs('alice', 'Alice', 'hello from instance A — ünïcode ✓')
  await serviceA.createLocalPostAs('alice', 'Alice', 'second transmission')

  // Instance B: ingests A's feed URL through the normal remote-user path
  const repoB = await createSqliteRepository(':memory:')
  const busB = createEventBus()
  const serviceB = createService(repoB, busB)
  const aliceAtB = await serviceB.addRemoteUser({ handle: 'alice-a', displayName: 'Alice (A)', feedUrl: 'http://a.example/users/alice/feed.xml' })

  const bridge = (async (url: string | URL | Request) => appA.request(String(url).replace('http://a.example', ''))) as unknown as typeof fetch
  const inserted = await ingestRemoteUser(repoB, busB, aliceAtB, bridge)
  expect(inserted).toBe(2)

  const timeline = await repoB.getTimeline(10)
  const contents = timeline.map((e) => e.content)
  expect(contents).toContain('hello from instance A — ünïcode ✓')
  expect(timeline.every((e) => e.source === 'remote')).toBe(true)
  expect(timeline[0].author.handle).toBe('alice-a')

  // guids survive the wire: A's post guids === B's stored guids
  const aGuids = (await repoA.getTimeline(10)).map((e) => e.guid).sort()
  const bGuids = timeline.map((e) => e.guid).sort()
  expect(bGuids).toEqual(aGuids)

  // idempotent re-ingest — the poller can hit A forever without duplicating
  expect(await ingestRemoteUser(repoB, busB, aliceAtB, bridge)).toBe(0)
})
