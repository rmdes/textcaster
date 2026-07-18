import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import type { Repository } from '../src/domain/repository.ts'
import type { Post } from '../src/domain/types.ts'

// createLocalUser always assigns a fresh UUID (NewLocalUser has no `id` field);
// authorId tracks the real generated id rather than assuming a fixed 'u1'.
let authorId = 'u1'

function localPost(over: Partial<Post> = {}): Post {
  const id = over.id ?? crypto.randomUUID()
  return { id, authorId, source: 'local', guid: over.guid ?? id, title: null, content: 'v1',
    url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
    inReplyTo: null, inReplyToPostId: null, threadRootId: null, sourceName: null, sourceFeedUrl: null,
    contentMarkdown: null, ...over }
}

describe('edit primitive', () => {
  let repo: Repository
  beforeEach(async () => {
    repo = await createSqliteRepository(':memory:')
    const u = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
    authorId = u.id
  })

  it('records an edit: snapshots prior, overwrites current, stamps edited_at', async () => {
    const p = localPost({ content: 'original' })
    await repo.insertPost(p)
    await repo.recordEdit(p.id, { title: null, content: 'corrected', contentMarkdown: null, editedAt: '2026-02-02T00:00:00.000Z' })
    const cur = await repo.getPost(p.id)
    expect(cur?.content).toBe('corrected')
    expect(cur?.editedAt).toBe('2026-02-02T00:00:00.000Z')
    const revs = await repo.getRevisions(p.id)
    expect(revs.map((r) => r.content)).toEqual(['original'])
    expect(revs[0].seenAt).toBe('2026-02-02T00:00:00.000Z')
  })

  it('never-edited post has no revisions and null edited_at', async () => {
    const p = localPost()
    await repo.insertPost(p)
    expect((await repo.getPost(p.id))?.editedAt ?? null).toBeNull()
    expect(await repo.getRevisions(p.id)).toEqual([])
  })

  it('getEditableByGuid returns stored fields by (author, guid)', async () => {
    const p = localPost({ guid: 'g-1', content: 'body', title: 'T' })
    await repo.insertPost(p)
    expect(await repo.getEditableByGuid(authorId, 'g-1')).toMatchObject({ id: p.id, title: 'T', content: 'body', contentMarkdown: null })
    expect(await repo.getEditableByGuid(authorId, 'missing')).toBeUndefined()
  })

  it('two edits accumulate two revisions oldest-first', async () => {
    const p = localPost({ content: 'a' })
    await repo.insertPost(p)
    await repo.recordEdit(p.id, { title: null, content: 'b', contentMarkdown: null, editedAt: '2026-02-01T00:00:00.000Z' })
    await repo.recordEdit(p.id, { title: null, content: 'c', contentMarkdown: null, editedAt: '2026-02-02T00:00:00.000Z' })
    expect((await repo.getRevisions(p.id)).map((r) => r.content)).toEqual(['a', 'b'])
    expect((await repo.getPost(p.id))?.content).toBe('c')
  })
})
