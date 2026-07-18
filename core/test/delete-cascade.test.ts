import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'

test('deleteUserCascade removes a remote user and its posts', async () => {
  const repo = await createSqliteRepository(':memory:')
  const u = await repo.createRemoteUser({ handle: 'peer', displayName: 'Peer', feedUrl: 'https://ex.com/f.xml' })
  await repo.insertPost({
    id: 'p1', authorId: u.id, source: 'remote', guid: 'g1', title: null, content: 'hi',
    url: 'https://ex.com/post/1', publishedAt: '2026-07-18T00:00:00Z', createdAt: '2026-07-18T00:00:00Z',
    inReplyTo: null, inReplyToPostId: null, threadRootId: null,
  })
  expect(await repo.getUserByHandle('peer')).toBeTruthy()

  repo.deleteUserCascade(u.id)

  expect(await repo.getUserByHandle('peer')).toBeUndefined()
  expect((await repo.getTimeline(50)).length).toBe(0)
})
