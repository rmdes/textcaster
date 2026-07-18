import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { ingestItems } from '../src/domain/ingest.ts'
import type { ParsedItem } from '../src/domain/ingest.ts'
import type { Repository } from '../src/domain/repository.ts'
import type { EventBus } from '../src/domain/bus.ts'
import type { User, TimelineEntry } from '../src/domain/types.ts'

describe('ingest edit-detection', () => {
  let repo: Repository, bus: EventBus, feed: User, emitted: TimelineEntry[]
  beforeEach(async () => {
    repo = await createSqliteRepository(':memory:')
    bus = createEventBus()
    emitted = []
    bus.onNewPost((e) => emitted.push(e))
    feed = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://blog.example/f.xml' })
  })
  const parsed = (over: Partial<ParsedItem> = {}): ParsedItem => ({
    guid: 'g1', title: null, content: 'x', url: null, publishedAt: '2026-01-01T00:00:00.000Z',
    inReplyTo: null, sourceName: null, sourceFeedUrl: null, contentMarkdown: null, updatedAt: null, ...over,
  })

  it('re-ingest same guid with changed body → revision + edited_at + emitted on new-post', async () => {
    await ingestItems(repo, bus, feed, [parsed({ content: 'first' })])
    emitted.length = 0
    await ingestItems(repo, bus, feed, [parsed({ content: 'second' })])
    const stored = await repo.getEditableByGuid(feed.id, 'g1')
    expect(stored?.content).toBe('second')
    expect((await repo.getRevisions(stored!.id)).map((r) => r.content)).toEqual(['first'])
    expect(emitted.some((e) => e.id === stored!.id)).toBe(true)
  })

  it('unchanged re-ingest → no revision, no emit', async () => {
    await ingestItems(repo, bus, feed, [parsed({ content: 'x' })])
    emitted.length = 0
    await ingestItems(repo, bus, feed, [parsed({ content: 'x' })])
    const stored = await repo.getEditableByGuid(feed.id, 'g1')
    expect(await repo.getRevisions(stored!.id)).toEqual([])
    expect(emitted).toEqual([])
  })

  it('attribution-only change → backfill, NOT an edit', async () => {
    await ingestItems(repo, bus, feed, [parsed({ content: 'x', sourceName: null })])
    await ingestItems(repo, bus, feed, [parsed({ content: 'x', sourceName: 'Origin' })])
    const stored = await repo.getEditableByGuid(feed.id, 'g1')
    expect(await repo.getRevisions(stored!.id)).toEqual([])
  })

  it('plain body edit with NO attribution/url/markdown is still detected (unconditional branch)', async () => {
    await ingestItems(repo, bus, feed, [parsed({ content: 'a' })])
    await ingestItems(repo, bus, feed, [parsed({ content: 'b' })])
    const stored = await repo.getEditableByGuid(feed.id, 'g1')
    expect((await repo.getRevisions(stored!.id)).length).toBe(1)
  })

  it('edited_at prefers a valid incoming updatedAt, else now', async () => {
    await ingestItems(repo, bus, feed, [parsed({ content: 'a' })])
    await ingestItems(repo, bus, feed, [parsed({ content: 'b', updatedAt: '2030-05-05T00:00:00.000Z' })])
    const stored = await repo.getEditableByGuid(feed.id, 'g1')
    expect((await repo.getPost(stored!.id))?.editedAt).toBe('2030-05-05T00:00:00.000Z')
  })
})
