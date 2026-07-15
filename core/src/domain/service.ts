import { randomUUID } from 'node:crypto'
import type { Repository } from './repository.ts'
import type { EventBus } from './bus.ts'
import type { NewRemoteUser, TimelineEntry, User, Post } from './types.ts'

export function createService(repo: Repository, bus: EventBus) {
  async function ensureLocalUser(handle: string, displayName: string): Promise<User> {
    const existing = await repo.getUserByHandle(handle)
    if (existing) {
      if (existing.kind !== 'local') throw new Error('handle belongs to a remote user')
      return existing
    }
    return repo.createLocalUser({ handle, displayName })
  }

  return {
    addRemoteUser(input: NewRemoteUser) {
      return repo.createRemoteUser(input)
    },
    async createLocalPostAs(handle: string, displayName: string, content: string): Promise<TimelineEntry> {
      const author = await ensureLocalUser(handle, displayName)
      const now = new Date().toISOString()
      const post: Post = { id: randomUUID(), authorId: author.id, source: 'local', guid: randomUUID(), content, url: null, publishedAt: now, createdAt: now }
      await repo.insertPost(post)
      const entry: TimelineEntry = { ...post, author }
      bus.emitNewPost(entry)
      return entry
    },
    getTimeline(limit = 100) {
      return repo.getTimeline(limit)
    },
  }
}

export type Service = ReturnType<typeof createService>
