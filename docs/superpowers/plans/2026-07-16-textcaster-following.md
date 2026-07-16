# Textcaster Following/Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-local-user follows across all user kinds, two filtered timeline lenses (followed + per-author), and OPML both ways (export follows, import to bulk-create-and-follow), with SSR web lens pages.

**Architecture:** Migration 4 adds a `follows` table (WITHOUT ROWID) + a composite `(author_id, published_at, id)` index. Filtering lives in the existing `getTimeline` keyset query (a new `filter` arg composes with the cursor predicate). OPML uses feedsmith's already-installed `parseOpml`/`generateOpml` — no new dependency. Import creates users only; the poller ingests them on its next cycle (backfill, SSRF guards, push-in discovery all apply for free). SSE and replay are untouched — lenses filter client-side.

**Tech Stack:** TypeScript (ESM, Node ≥22.18), Hono, Kysely + better-sqlite3, feedsmith, Vitest, SvelteKit.

**Spec:** `docs/superpowers/specs/2026-07-16-textcaster-following-design.md` (rev 2, 80c74a1)
**Review incorporated:** `docs/superpowers/reviews/2026-07-16-following-spec-review.md` (H1–H6 + pins, all folded into rev 2).

## Global Constraints

- **TypeScript, ESM, Node ≥22.18.** No build step — `node --watch` runs source via native type stripping (no parameter properties).
- **Storage-agnostic core:** domain/service/API depend only on the `Repository` interface. No SQL outside `storage/sqlite.ts`. Real-time is the in-process bus, never DB pub/sub.
- **`web/` NEVER imports from `core/`** — HTTP only, with its own wire types.
- **No-JS is first-class:** every page renders and every form works with JavaScript disabled; JS only enhances (live SSE).
- **TDD:** failing test first, then minimal code. **Vitest** in both packages. `npm test -w core` / `npm run typecheck -w core` / `npm test -w web` / `npm run check -w web` must all stay green at each task's end.
- **One migration array, never edit earlier entries** — append only (`MIGRATIONS[3]` is this milestone).
- **Follower MUST be a local user — enforced in the service (a `DomainError`), never the schema.** `app.onError` maps `DomainError` → 400; the API returns 404 for unknown handles *before* calling the service.
- **DEFERRED — do NOT build:** mute/block, follower counts, reverse "who-follows-X" queries, follow suggestions, private lenses, following remotes' OPML, any SSE-protocol change.
- **Web UI tasks:** invoke `ui-ux-pro-max:ui-ux-pro-max` before writing markup, per CLAUDE.md and `design-system/textcaster/MASTER.md`. The markup in Tasks 7–8 is functional and follows the existing `+page.svelte` patterns; the design-system pass refines styling only.
- Commit after each task; end every commit message with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File structure

```
core/src/
  storage/sqlite.ts          # MODIFY: migration 4, follows methods, getTimeline filter
  domain/repository.ts       # MODIFY: addFollow/removeFollow/listFollowing, getTimeline filter arg
  domain/repository-contract.ts # MODIFY: follows + lens contract pins
  domain/service.ts          # MODIFY: follow ops, getTimeline filter, lens-by-handle helpers
  domain/opml.ts             # CREATE: buildFollowingOpml + importOpml (flatten, slugify, resolve)
  api/app.ts                 # MODIFY: follow routes, lens query params, OPML routes
core/test/
  opml.test.ts               # CREATE: export/import unit tests
  api-follows.test.ts        # CREATE: follow + lens + OPML HTTP tests
  federation-following.test.ts # CREATE: OPML round-trip across two in-memory instances
web/src/lib/
  types.ts                   # MODIFY: add author.id to the wire type
  api.ts                     # MODIFY: getTimeline gains a filter opts arg; follow/OPML client fns
  lens.ts                    # CREATE: keepEvent drop-predicate (island filtering)
  lens.test.ts               # CREATE: predicate unit tests
web/src/routes/
  u/[handle]/+page.server.ts # CREATE: author lens load
  u/[handle]/+page.svelte    # CREATE: author lens render
  u/[handle]/following/+page.server.ts # CREATE: followed lens load + follow/unfollow/import actions
  u/[handle]/following/+page.svelte    # CREATE: lens + follow list + forms + export link
```

---

### Task 1: Migration 4 + follows repository methods

**Files:**
- Modify: `core/src/domain/repository.ts`
- Modify: `core/src/storage/sqlite.ts` (MIGRATIONS append; follows methods)
- Modify: `core/src/domain/repository-contract.ts` (append contract pins)
- Test: `core/test/sqlite-repository.test.ts` already runs the contract against `:memory:` — no change needed.

**Interfaces:**
- Produces: `Repository.addFollow(followerId, followedId): Promise<void>` (idempotent), `removeFollow(followerId, followedId): Promise<void>` (idempotent), `listFollowing(followerId): Promise<User[]>` (follow `created_at ASC`). Migration 4 creates `follows` + `posts_author_pub_idx`.
- Consumes: existing `User`, `SqliteRepository`, `MIGRATIONS`.

- [ ] **Step 1: Add the three methods to the Repository interface**

In `core/src/domain/repository.ts`, add after `listRemoteUsers(): Promise<User[]>`:
```ts
  addFollow(followerId: string, followedId: string): Promise<void>
  removeFollow(followerId: string, followedId: string): Promise<void>
  listFollowing(followerId: string): Promise<User[]>
```

- [ ] **Step 2: Write the failing contract tests**

In `core/src/domain/repository-contract.ts`, add inside the `describe('Repository contract', …)` block (after the existing tests):
```ts
    test('addFollow is idempotent and listFollowing returns follows in created_at order', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const b = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
      const c = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://ex.com/b.xml' })
      await repo.addFollow(a.id, b.id)
      await repo.addFollow(a.id, c.id)
      await repo.addFollow(a.id, b.id) // duplicate — no throw, no second row
      const following = await repo.listFollowing(a.id)
      // created_at ASC is the primary order (spec); the two adds land in the same
      // millisecond, so a handle-ASC tiebreak makes the result deterministic (P2).
      expect(following.map((u) => u.handle)).toEqual(['blog', 'news'])
    })

    test('removeFollow is idempotent (removing a non-follow is a no-op)', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const b = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
      await repo.removeFollow(a.id, b.id) // never followed — no throw
      await repo.addFollow(a.id, b.id)
      await repo.removeFollow(a.id, b.id)
      await repo.removeFollow(a.id, b.id) // already gone — no throw
      expect(await repo.listFollowing(a.id)).toEqual([])
    })

    test('self-follow is allowed and needs no special-casing', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      await repo.addFollow(a.id, a.id)
      expect((await repo.listFollowing(a.id)).map((u) => u.id)).toEqual([a.id])
    })
```

- [ ] **Step 3: Run — verify it fails**

Run: `npm test -w core`
Expected: FAIL — `repo.addFollow is not a function`.

- [ ] **Step 4: Append migration 4**

In `core/src/storage/sqlite.ts`, add a fourth element to the `MIGRATIONS` array (after the `push_subscriptions` block, before the closing `]`):
```ts
  [
    `CREATE TABLE follows (
      follower_id text NOT NULL REFERENCES users(id),
      followed_id text NOT NULL REFERENCES users(id),
      created_at text NOT NULL,
      PRIMARY KEY (follower_id, followed_id)
    ) WITHOUT ROWID`,
    'CREATE INDEX posts_author_pub_idx ON posts (author_id, published_at, id)',
  ],
```

- [ ] **Step 5: Add the `follows` table type and the three methods**

In `core/src/storage/sqlite.ts`:

Add to the `DB` interface and a table type (near the other `*Table` interfaces):
```ts
interface FollowsTable { follower_id: string; followed_id: string; created_at: string }
```
Add `follows: FollowsTable` to the `interface DB { … }` line.

Add these methods to the `SqliteRepository` class (after `listRemoteUsers`):
```ts
  async addFollow(followerId: string, followedId: string) {
    await this.db
      .insertInto('follows')
      .values({ follower_id: followerId, followed_id: followedId, created_at: new Date().toISOString() })
      // follows has only the PK constraint, so bare doNothing() targets it.
      .onConflict((oc) => oc.doNothing())
      .execute()
  }
  async removeFollow(followerId: string, followedId: string) {
    await this.db.deleteFrom('follows').where('follower_id', '=', followerId).where('followed_id', '=', followedId).execute()
  }
  async listFollowing(followerId: string): Promise<User[]> {
    const rows = await this.db
      .selectFrom('follows')
      .innerJoin('users', 'users.id', 'follows.followed_id')
      .select(['users.id as id', 'users.kind as kind', 'users.handle as handle', 'users.display_name as display_name', 'users.feed_url as feed_url', 'users.created_at as created_at'])
      .where('follows.follower_id', '=', followerId)
      .orderBy('follows.created_at', 'asc')
      .orderBy('users.handle', 'asc') // deterministic tiebreak for same-ms follows (P2)
      .execute()
    return rows.map(rowToUser)
  }
```

- [ ] **Step 6: Run — verify GREEN + typecheck**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS (the three new contract tests + all existing); typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(printf 'core: migration 4 — follows table + follow repository methods\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 2: Filtered timeline (followedBy + authorId)

**Files:**
- Modify: `core/src/domain/repository.ts` (extend `getTimeline` signature)
- Modify: `core/src/storage/sqlite.ts` (`getTimeline` filter)
- Modify: `core/src/domain/repository-contract.ts` (filter pins)

**Interfaces:**
- Produces: `getTimeline(limit, before?, filter?: { followedBy?: string; authorId?: string }): Promise<TimelineEntry[]>` — `followedBy` scopes to posts whose author the given user follows; `authorId` scopes to one author; same `(published_at DESC, id DESC)` ordering + cursor semantics.
- Consumes: Task 1's `follows` table.

- [ ] **Step 1: Extend the interface signature**

In `core/src/domain/repository.ts`, replace the `getTimeline` line with:
```ts
  getTimeline(limit: number, before?: TimelineCursor, filter?: { followedBy?: string; authorId?: string }): Promise<TimelineEntry[]>
```

- [ ] **Step 2: Write the failing contract tests**

In `core/src/domain/repository-contract.ts`, add inside the contract block:
```ts
    test('followedBy filter scopes the timeline to followed authors, paginating across boundaries', async () => {
      const repo = await makeRepo()
      const me = await repo.createLocalUser({ handle: 'me', displayName: 'Me' })
      const x = await repo.createRemoteUser({ handle: 'x', displayName: 'X', feedUrl: 'https://ex.com/x.xml' })
      const y = await repo.createRemoteUser({ handle: 'y', displayName: 'Y', feedUrl: 'https://ex.com/y.xml' })
      await repo.addFollow(me.id, x.id) // follows X, not Y
      const mk = (id: string, author: string, day: string) => repo.insertPost({ id, authorId: author, source: 'remote', guid: id, title: null, content: id, url: null, publishedAt: `2026-01-${day}T00:00:00.000Z`, createdAt: `2026-01-${day}T00:00:00.000Z` })
      await mk('x1', x.id, '01'); await mk('y1', y.id, '02'); await mk('x2', x.id, '03'); await mk('y2', y.id, '04')
      const page1 = await repo.getTimeline(1, undefined, { followedBy: me.id })
      expect(page1.map((e) => e.id)).toEqual(['x2']) // newest followed post, Y excluded
      const page2 = await repo.getTimeline(1, { publishedAt: page1[0].publishedAt, id: page1[0].id }, { followedBy: me.id })
      expect(page2.map((e) => e.id)).toEqual(['x1'])
    })

    test('authorId filter scopes to one author (works for remote authors too)', async () => {
      const repo = await makeRepo()
      const x = await repo.createRemoteUser({ handle: 'x', displayName: 'X', feedUrl: 'https://ex.com/x.xml' })
      const y = await repo.createRemoteUser({ handle: 'y', displayName: 'Y', feedUrl: 'https://ex.com/y.xml' })
      await repo.insertPost({ id: 'x1', authorId: x.id, source: 'remote', guid: 'x1', title: null, content: 'x1', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
      await repo.insertPost({ id: 'y1', authorId: y.id, source: 'remote', guid: 'y1', title: null, content: 'y1', url: null, publishedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-02T00:00:00.000Z' })
      const tl = await repo.getTimeline(10, undefined, { authorId: x.id })
      expect(tl.map((e) => e.id)).toEqual(['x1'])
    })
```

- [ ] **Step 3: Run — verify it fails**

Run: `npm test -w core`
Expected: FAIL — `followedBy` posts leak (filter ignored), assertions mismatch.

- [ ] **Step 4: Add the filter to `getTimeline`**

In `core/src/storage/sqlite.ts`, replace the `getTimeline` method body's signature and add the filter clauses. The method becomes:
```ts
  async getTimeline(limit: number, before?: TimelineCursor, filter?: { followedBy?: string; authorId?: string }): Promise<TimelineEntry[]> {
    let q = this.db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .selectAll('posts')
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at'])
      .orderBy('posts.published_at', 'desc')
      .orderBy('posts.id', 'desc')
      .limit(limit)
    if (before) {
      q = q.where((eb) => eb(eb.refTuple('posts.published_at', 'posts.id'), '<', eb.tuple(before.publishedAt, before.id)))
    }
    if (filter?.followedBy) {
      const followerId = filter.followedBy
      q = q.where('posts.author_id', 'in', (eb) => eb.selectFrom('follows').select('followed_id').where('follower_id', '=', followerId))
    }
    if (filter?.authorId) {
      q = q.where('posts.author_id', '=', filter.authorId)
    }
    const rows = await q.execute()
    return rows.map(joinedRowToEntry)
  }
```

- [ ] **Step 5: Run — verify GREEN + typecheck**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS; typecheck exit 0. (Note: `service.getTimeline` still calls `repo.getTimeline(limit, before)` — the new arg is optional, so nothing breaks.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(printf 'core: filtered timeline lenses (followedBy + authorId) in the keyset query\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 3: Service — follow ops + lens passthrough

**Files:**
- Modify: `core/src/domain/service.ts`
- Test: `core/test/service.test.ts` (append)

**Interfaces:**
- Produces on the `Service` object: `addFollow(follower: User, target: User): Promise<void>` (throws `DomainError('follower must be a local user')` when `follower.kind !== 'local'`, else idempotent `repo.addFollow`), `removeFollow(followerId, targetId): Promise<void>`, `listFollowing(userId): Promise<User[]>`, and `getTimeline(limit?, before?, filter?)` extended to pass the filter through.
- Consumes: Task 1/2 repo methods.

- [ ] **Step 1: Write the failing test**

In `core/test/service.test.ts`, add:
```ts
import { DomainError } from '../src/domain/types.ts'

test('addFollow requires a local follower and is idempotent', async () => {
  const { repo, svc } = await setup()
  const alice = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  const news = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  await svc.addFollow(alice, news)
  await svc.addFollow(alice, news) // idempotent
  expect((await svc.listFollowing(alice.id)).map((u) => u.handle)).toEqual(['news'])
  await expect(svc.addFollow(news, alice)).rejects.toBeInstanceOf(DomainError) // remote follower rejected
})

test('followed lens passes the filter through', async () => {
  const { repo, svc } = await setup()
  const me = await repo.createLocalUser({ handle: 'me', displayName: 'Me' })
  const x = await repo.createRemoteUser({ handle: 'x', displayName: 'X', feedUrl: 'https://ex.com/x.xml' })
  await svc.addFollow(me, x)
  await repo.insertPost({ id: 'x1', authorId: x.id, source: 'remote', guid: 'x1', title: null, content: 'x1', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  const tl = await svc.getTimeline(10, undefined, { followedBy: me.id })
  expect(tl.map((e) => e.id)).toEqual(['x1'])
})
```
Note: `setup()` already exists at the top of `service.test.ts` and returns `{ repo, bus, svc }`.

- [ ] **Step 2: Run — verify it fails**

Run: `npm test -w core`
Expected: FAIL — `svc.addFollow is not a function`.

- [ ] **Step 3: Implement**

In `core/src/domain/service.ts`, extend the returned object. Change the `getTimeline` method and add the follow methods:
```ts
    getTimeline(limit = 100, before?: TimelineCursor, filter?: { followedBy?: string; authorId?: string }) {
      return repo.getTimeline(limit, before, filter)
    },
    async addFollow(follower: User, target: User): Promise<void> {
      if (follower.kind !== 'local') throw new DomainError('follower must be a local user')
      await repo.addFollow(follower.id, target.id)
    },
    removeFollow(followerId: string, targetId: string) {
      return repo.removeFollow(followerId, targetId)
    },
    listFollowing(userId: string) {
      return repo.listFollowing(userId)
    },
```
(`DomainError` and `User` are already imported in `service.ts`.)

- [ ] **Step 4: Run — verify GREEN + typecheck**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS; typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(printf 'core: service follow ops (local-follower rule) + lens passthrough\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 4: Follow + lens HTTP routes

**Files:**
- Modify: `core/src/api/app.ts`
- Test: `core/test/api-follows.test.ts` (create)

**Interfaces:**
- Produces:
  - `POST /users/:handle/follows` (bearer) body `{ handle: <target> }` → `200 { ok: true }`; 404 unknown either handle; 400 when `:handle` not local.
  - `DELETE /users/:handle/follows/:target` (bearer) → `200 { ok: true }` idempotent; 404 only for unknown handles.
  - `GET /users/:handle/follows` (public) → `{ following: User[] }`.
  - `GET /timeline?followed_by=<handle>` and `?author=<handle>` — both together → 400 (checked before handle resolution); unknown handle → 404.
- Consumes: Task 3 service methods, existing `service.getUserByHandle`.

- [ ] **Step 1: Write the failing tests**

Create `core/test/api-follows.test.ts`:
```ts
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
```

- [ ] **Step 2: Run — verify it fails**

Run: `npm test -w core`
Expected: FAIL — routes 404 / assertions mismatch.

- [ ] **Step 3: Add a handle-resolution helper + follow routes**

In `core/src/api/app.ts`, add these routes inside `createApp` (place them after the `POST /posts` route, before `const FEED_LIMIT`):
```ts
  async function resolveUser(handleRaw: string): Promise<import('../domain/types.ts').User | undefined> {
    return service.getUserByHandle(handleRaw.toLowerCase())
  }

  app.post('/users/:handle/follows', bearerAuth(token), async (c) => {
    const body = await readJsonBody(c)
    if (!body || !isString(body.handle, 1, 64)) return c.json({ error: 'handle invalid' }, 400)
    const follower = await resolveUser(c.req.param('handle') ?? '')
    const target = await resolveUser(body.handle)
    if (!follower || !target) return c.json({ error: 'unknown user' }, 404)
    await service.addFollow(follower, target) // throws DomainError → 400 if follower not local
    return c.json({ ok: true }, 200)
  })

  app.delete('/users/:handle/follows/:target', bearerAuth(token), async (c) => {
    const follower = await resolveUser(c.req.param('handle') ?? '')
    const target = await resolveUser(c.req.param('target') ?? '')
    if (!follower || !target) return c.json({ error: 'unknown user' }, 404)
    await service.removeFollow(follower.id, target.id)
    return c.json({ ok: true }, 200)
  })

  app.get('/users/:handle/follows', async (c) => {
    const user = await resolveUser(c.req.param('handle') ?? '')
    if (!user) return c.json({ error: 'unknown user' }, 404)
    return c.json({ following: await service.listFollowing(user.id) })
  })
```

- [ ] **Step 4: Add the lens query params to `GET /timeline`**

In `core/src/api/app.ts`, inside the existing `app.get('/timeline', …)` handler, insert this block immediately after the `limit` parsing and before `const timeline = await service.getTimeline(...)`:
```ts
    const followedByRaw = c.req.query('followed_by')
    const authorRaw = c.req.query('author')
    if (followedByRaw !== undefined && authorRaw !== undefined) return c.json({ error: 'followed_by and author are mutually exclusive' }, 400)
    let filter: { followedBy?: string; authorId?: string } | undefined
    if (followedByRaw !== undefined) {
      const u = await resolveUser(followedByRaw)
      if (!u) return c.json({ error: 'unknown user' }, 404)
      filter = { followedBy: u.id }
    } else if (authorRaw !== undefined) {
      const u = await resolveUser(authorRaw)
      if (!u) return c.json({ error: 'unknown user' }, 404)
      filter = { authorId: u.id }
    }
```
Then change the timeline call to pass the filter:
```ts
    const timeline = await service.getTimeline(limit, before, filter)
```

- [ ] **Step 5: Run — verify GREEN + typecheck**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(printf 'core: follow routes + timeline lens query params\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 5: OPML export

**Files:**
- Create: `core/src/domain/opml.ts`
- Modify: `core/src/api/app.ts` (export route)
- Test: `core/test/opml.test.ts` (create; import tests added in Task 6)

**Interfaces:**
- Produces: `buildFollowingOpml(displayName: string, following: User[], publicUrl: string | null): string` — one `<outline type="rss" text=… xmlUrl=…>` per followed user; remote → `feedUrl`; local → `<publicUrl>/users/<handle>/feed.xml`; local users **omitted** when `publicUrl` is null (H4). Route `GET /users/:handle/following.opml`, content-type `text/xml; charset=utf-8`.
- Consumes: feedsmith `generateOpml`, `feedUrls` from `domain/feed.ts`.

- [ ] **Step 1: Write the failing test**

Create `core/test/opml.test.ts`:
```ts
import { test, expect } from 'vitest'
import { buildFollowingOpml } from '../src/domain/opml.ts'
import type { User } from '../src/domain/types.ts'

const remote = (h: string, feed: string): User => ({ id: h, kind: 'remote', handle: h, displayName: h.toUpperCase(), feedUrl: feed, createdAt: '2026-01-01T00:00:00.000Z' })
const local = (h: string): User => ({ id: h, kind: 'local', handle: h, displayName: h, feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z' })

test('export emits remote feedUrl and minted local feed.xml when public URL is set', () => {
  const opml = buildFollowingOpml('Alice', [remote('news', 'https://ex.com/f.xml'), local('bob')], 'https://cast.example')
  expect(opml).toContain('xmlUrl="https://ex.com/f.xml"')
  expect(opml).toContain('xmlUrl="https://cast.example/users/bob/feed.xml"')
})

test('export omits local-user outlines when no public URL (H4)', () => {
  const opml = buildFollowingOpml('Alice', [remote('news', 'https://ex.com/f.xml'), local('bob')], null)
  expect(opml).toContain('https://ex.com/f.xml')
  expect(opml).not.toContain('bob')
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `npm test -w core`
Expected: FAIL — cannot resolve `../src/domain/opml.ts`.

- [ ] **Step 3: Implement `buildFollowingOpml`**

Create `core/src/domain/opml.ts`:
```ts
import { generateOpml } from 'feedsmith'
import { feedUrls } from './feed.ts'
import type { User } from './types.ts'

export function buildFollowingOpml(displayName: string, following: User[], publicUrl: string | null): string {
  const outlines: Array<{ type: 'rss'; text: string; xmlUrl: string }> = []
  for (const u of following) {
    if (u.kind === 'remote' && u.feedUrl) {
      outlines.push({ type: 'rss', text: u.displayName, xmlUrl: u.feedUrl })
    } else if (u.kind === 'local' && publicUrl) {
      outlines.push({ type: 'rss', text: u.displayName, xmlUrl: feedUrls(publicUrl, u.handle).xml })
    }
    // local && !publicUrl → omitted (H4): a relative URL is junk to any aggregator.
  }
  return generateOpml({ head: { title: `${displayName} — following` }, body: { outlines } })
}
```

- [ ] **Step 4: Add the export route**

In `core/src/api/app.ts`, add after the `GET /users/:handle/follows` route:
```ts
  app.get('/users/:handle/following.opml', async (c) => {
    const user = await resolveUser(c.req.param('handle') ?? '')
    if (!user) return c.json({ error: 'unknown user' }, 404)
    const following = await service.listFollowing(user.id)
    const opml = buildFollowingOpml(user.displayName, following, feeds.publicUrl)
    return c.body(opml, 200, { 'content-type': 'text/xml; charset=utf-8' })
  })
```
Add the import at the top of `app.ts` (next to the `renderRssFeed` import):
```ts
import { buildFollowingOpml } from '../domain/opml.ts'
```

- [ ] **Step 5: Run — verify GREEN + typecheck**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(printf 'core: OPML export of a user'"'"'s follows\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 6: OPML import

**Files:**
- Modify: `core/src/domain/opml.ts` (add `importFollowingOpml`)
- Modify: `core/src/api/app.ts` (import route)
- Test: `core/test/opml.test.ts` (append)

**Interfaces:**
- Produces: `importFollowingOpml(deps, follower: User, body: string): Promise<{ followed: number; created: number; skipped: number }>` where `deps = { listRemoteUsers, getUserByHandle, addRemoteUser, addFollow, publicUrl }`. Recursively flattens outlines; per feed-outline resolves case 1 (existing feedUrl → follow), case 2 (our own minted feed.xml/feed.json → follow the local user), case 3 (create remote + follow); skips no-xmlUrl / duplicate-xmlUrl / errored / over-cap outlines. Route `POST /users/:handle/follows/opml` (bearer, 1 MB body cap) → `200 { followed, created, skipped }`.
- Consumes: feedsmith `parseOpml`, `feedUrls`, service `addRemoteUser`/`addFollow`, repo `listRemoteUsers`/`getUserByHandle`.

- [ ] **Step 1: Write the failing tests**

Append to `core/test/opml.test.ts`:
```ts
import { importFollowingOpml } from '../src/domain/opml.ts'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'

async function importSetup(publicUrl: string | null) {
  const repo = await createSqliteRepository(':memory:')
  const svc = createService(repo, createEventBus())
  const follower = await repo.createLocalUser({ handle: 'me', displayName: 'Me' })
  const deps = {
    listRemoteUsers: () => repo.listRemoteUsers(),
    getUserByHandle: (h: string) => repo.getUserByHandle(h),
    addRemoteUser: (i: { handle: string; displayName: string; feedUrl: string }) => svc.addRemoteUser(i),
    addFollow: (f: typeof follower, t: typeof follower) => svc.addFollow(f, t),
    publicUrl,
  }
  return { repo, svc, follower, deps }
}

test('import walks nested folders (H1), creates+follows, dedups by xmlUrl', async () => {
  const { repo, follower, deps } = await importSetup('https://cast.example')
  const opml = `<opml version="2.0"><head><title>t</title></head><body>
    <outline text="Tech"><outline type="rss" text="A Blog" xmlUrl="https://a.com/f.xml"/></outline>
    <outline type="rss" text="B" xmlUrl="https://b.com/f.xml"/>
    <outline type="rss" text="B dup" xmlUrl="https://b.com/f.xml"/>
    <outline text="empty folder no url"/>
  </body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r).toEqual({ followed: 2, created: 2, skipped: 1 }) // dup xmlUrl skipped; folder outline is structure, not a skip
  const following = await repo.listFollowing(follower.id)
  expect(following.map((u) => u.feedUrl).sort()).toEqual(['https://a.com/f.xml', 'https://b.com/f.xml'])
})

test('import follows an existing remote by feedUrl (case 1) without creating a duplicate', async () => {
  const { repo, svc, follower, deps } = await importSetup('https://cast.example')
  await svc.addRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  const opml = `<opml><body><outline type="rss" text="News" xmlUrl="https://ex.com/f.xml"/></body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r).toEqual({ followed: 1, created: 0, skipped: 0 })
  expect((await repo.listRemoteUsers()).length).toBe(1)
})

test('import follows a local user for our own minted feed.json URL, not a remote shadow (H2)', async () => {
  const { repo, follower, deps } = await importSetup('https://cast.example')
  const bob = await repo.createLocalUser({ handle: 'bob', displayName: 'Bob' })
  const opml = `<opml><body><outline type="rss" text="Bob" xmlUrl="https://cast.example/users/bob/feed.json"/></body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r).toEqual({ followed: 1, created: 0, skipped: 0 })
  expect((await repo.listFollowing(follower.id)).map((u) => u.id)).toEqual([bob.id])
  expect((await repo.listRemoteUsers()).length).toBe(0) // no shadow created
})

test('import skips non-http(s) xmlUrls without creating users (P1)', async () => {
  const { repo, follower, deps } = await importSetup('https://cast.example')
  const opml = `<opml><body>
    <outline type="rss" text="FTP" xmlUrl="ftp://x.com/f.xml"/>
    <outline type="rss" text="JS" xmlUrl="javascript:alert(1)"/>
    <outline type="rss" text="Garbage" xmlUrl="not a url"/>
  </body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r).toEqual({ followed: 0, created: 0, skipped: 3 })
  expect((await repo.listRemoteUsers()).length).toBe(0)
})

test('same-slug outlines collide on handle and get suffixed (H3)', async () => {
  const { repo, follower, deps } = await importSetup(null)
  const opml = `<opml><body>
    <outline type="rss" text="My Blog!" xmlUrl="https://one.com/f.xml"/>
    <outline type="rss" text="My Blog?" xmlUrl="https://two.com/f.xml"/>
  </body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r.created).toBe(2)
  const handles = (await repo.listRemoteUsers()).map((u) => u.handle).sort()
  expect(handles).toEqual(['my-blog', 'my-blog-2'])
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `npm test -w core`
Expected: FAIL — `importFollowingOpml is not a function`.

- [ ] **Step 3: Implement `importFollowingOpml`**

First fix the imports at the TOP of `core/src/domain/opml.ts` (Task 5 already imported `generateOpml`, `feedUrls`, and `User` — extend those lines rather than re-importing, or the duplicate imports fail typecheck). The import block becomes exactly:
```ts
import { generateOpml, parseOpml } from 'feedsmith'
import { feedUrls } from './feed.ts'
import { HandleTakenError } from './types.ts'
import type { User, NewRemoteUser } from './types.ts'
```

Then append the import logic to `core/src/domain/opml.ts`:
```ts
const MAX_OUTLINES = 1000 // H5: bound user creation per import
const MAX_HANDLE_ATTEMPTS = 50

interface Outline { text?: string; title?: string; xmlUrl?: string; outlines?: Outline[] }

// Import calls the service directly, which does NOT validate the URL scheme
// (that guard lives only in the POST /users route). Without this check a
// non-http(s) xmlUrl would create a permanent user the poller can never fetch
// (new URL() throws every cycle, forever) — P1.
function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u).protocol
    return p === 'http:' || p === 'https:'
  } catch {
    return false
  }
}

function flatten(outlines: Outline[] | undefined, out: Outline[]): void {
  for (const o of outlines ?? []) {
    if (typeof o.xmlUrl === 'string') out.push(o)
    if (o.outlines) flatten(o.outlines, out) // folders are structure, not feeds (H1)
  }
}

function slugBase(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 61) // 64 − room for "-50" (H3)
  return s || 'feed'
}

export interface ImportDeps {
  listRemoteUsers: () => Promise<User[]>
  getUserByHandle: (h: string) => Promise<User | undefined>
  addRemoteUser: (i: NewRemoteUser) => Promise<User>
  addFollow: (follower: User, target: User) => Promise<void>
  publicUrl: string | null
}

// Parse an "our own feed" URL → the local handle it points at, else null (H2: both minted URLs).
function localHandleForUrl(url: string, publicUrl: string | null): string | null {
  if (!publicUrl) return null
  const prefix = `${publicUrl}/users/`
  if (!url.startsWith(prefix)) return null
  const rest = url.slice(prefix.length) // "<handle>/feed.xml" | "<handle>/feed.json"
  const m = /^([^/]+)\/feed\.(xml|json)$/.exec(rest)
  return m ? m[1] : null
}

export async function importFollowingOpml(deps: ImportDeps, follower: User, body: string): Promise<{ followed: number; created: number; skipped: number }> {
  const parsed = parseOpml(body)
  const flat: Outline[] = []
  flatten(parsed.body?.outlines as Outline[] | undefined, flat)

  const byFeedUrl = new Map((await deps.listRemoteUsers()).map((u) => [u.feedUrl as string, u]))
  const seenUrls = new Set<string>()
  const assignedHandles = new Set<string>()
  let followed = 0, created = 0, skipped = 0

  for (const o of flat.slice(0, MAX_OUTLINES)) {
    const xmlUrl = o.xmlUrl as string
    if (seenUrls.has(xmlUrl)) { skipped++; continue } // duplicate xmlUrl in file
    seenUrls.add(xmlUrl)
    if (!isHttpUrl(xmlUrl)) { skipped++; continue } // P1: non-http(s) → skip, never create
    try {
      // Case 1: a remote user already has this feedUrl.
      const existing = byFeedUrl.get(xmlUrl)
      if (existing) { await deps.addFollow(follower, existing); followed++; continue }
      // Case 2: one of our own minted local feed URLs (H2).
      const localHandle = localHandleForUrl(xmlUrl, deps.publicUrl)
      if (localHandle) {
        const localUser = await deps.getUserByHandle(localHandle)
        if (localUser && localUser.kind === 'local') { await deps.addFollow(follower, localUser); followed++; continue }
      }
      // Case 3: create a remote user, then follow.
      const displayName = (o.text ?? o.title ?? '').trim() || xmlUrl
      const base = slugBase(o.text ?? o.title ?? '')
      let handleUser: User | undefined
      for (let n = 1; n <= MAX_HANDLE_ATTEMPTS; n++) {
        const candidate = n === 1 ? base : `${base}-${n}`
        if (assignedHandles.has(candidate)) continue // same-slug collision within this file (H3)
        try {
          handleUser = await deps.addRemoteUser({ handle: candidate, displayName, feedUrl: xmlUrl })
          assignedHandles.add(candidate)
          break
        } catch (err) {
          if (err instanceof HandleTakenError) continue // collision in DB — try next suffix
          throw err // invalid feedUrl scheme etc. → outer catch skips
        }
      }
      if (!handleUser) { skipped++; continue } // exhausted attempts
      byFeedUrl.set(xmlUrl, handleUser)
      await deps.addFollow(follower, handleUser)
      created++; followed++
    } catch {
      skipped++ // create/follow errored (e.g. non-http(s) xmlUrl) — keep going
    }
  }
  return { followed, created, skipped }
}
```
(The import block was already corrected at the top of this step — `User`, `NewRemoteUser`, `HandleTakenError`, `parseOpml`, `feedUrls` are all in scope.)

- [ ] **Step 4: Add the import route**

In `core/src/api/app.ts`, add the `parseOpml`-backed route (after the export route). It reads raw text (content-type-agnostic) with a 1 MB cap:
```ts
  app.post('/users/:handle/follows/opml', bearerAuth(token), bodyLimit({ maxSize: 1024 * 1024, onError: rejectOversized }), async (c) => {
    const follower = await resolveUser(c.req.param('handle') ?? '')
    if (!follower) return c.json({ error: 'unknown user' }, 404)
    if (follower.kind !== 'local') return c.json({ error: 'follower must be a local user' }, 400)
    const body = await c.req.text()
    const result = await importFollowingOpml(
      {
        listRemoteUsers: () => service.listRemoteUsers(),
        getUserByHandle: (h) => service.getUserByHandle(h),
        addRemoteUser: (i) => service.addRemoteUser(i),
        addFollow: (f, t) => service.addFollow(f, t),
        publicUrl: feeds.publicUrl,
      },
      follower,
      body,
    )
    return c.json(result, 200)
  })
```
Update the `opml.ts` import at the top of `app.ts`:
```ts
import { buildFollowingOpml, importFollowingOpml } from '../domain/opml.ts'
```

- [ ] **Step 5: Expose `listRemoteUsers` on the service**

`importFollowingOpml`'s deps need `listRemoteUsers`. In `core/src/domain/service.ts`, add to the returned object:
```ts
    listRemoteUsers() {
      return repo.listRemoteUsers()
    },
```

- [ ] **Step 6: Run — verify GREEN + typecheck**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS; typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(printf 'core: OPML import — recursive flatten, slug collisions, self-feed detection, caps\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 7: Federation round-trip test (OPML both ways)

**Files:**
- Create: `core/test/federation-following.test.ts`

**Interfaces:**
- Consumes everything above. No new production code — this is the milestone's definition of done: export instance 1's follows, import into a fresh instance 2, assert the recreated remote users + follows. If it reveals a wiring bug, fix the offending task's code here.

- [ ] **Step 1: Write the round-trip test**

Create `core/test/federation-following.test.ts`:
```ts
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
```

- [ ] **Step 2: Run — verify GREEN (or fix the wiring the test exposes)**

Run: `npm test -w core && npm run typecheck -w core`
Expected: PASS. If it fails, the bug is in Tasks 4–6's wiring — fix there, do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "$(printf 'core: OPML round-trip federation test (export → import recreates follows)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 8: Web — lens pages, follow UI, live filtering

**REQUIRED before writing markup:** invoke `ui-ux-pro-max:ui-ux-pro-max` (per CLAUDE.md + `design-system/textcaster/MASTER.md`). The markup below is functional and mirrors the existing `+page.svelte` patterns; the design-system pass refines styling only.

**Files:**
- Modify: `web/src/lib/types.ts` (add `author.id`)
- Modify: `web/src/lib/api.ts` (getTimeline filter opts; follow/OPML client fns)
- Modify: `web/src/routes/+page.server.ts` (update the one `getTimeline` call site)
- Create: `web/src/lib/lens.ts` + `web/src/lib/lens.test.ts` (island drop-predicate)
- Create: `web/src/routes/u/[handle]/+page.server.ts` + `+page.svelte` (author lens)
- Create: `web/src/routes/u/[handle]/following/+page.server.ts` + `+page.svelte` (followed lens + forms)

**Interfaces:**
- Produces: author lens at `/u/<handle>`, followed lens + follow management at `/u/<handle>/following`, both SSR + no-JS forms, live island filtered client-side.
- Consumes: the Task 4–6 HTTP routes.

- [ ] **Step 1: Add `author.id` to the wire type**

In `web/src/lib/types.ts`, change the `author` field:
```ts
	author: { id: string; handle: string; displayName: string; kind: 'local' | 'remote' }
```

- [ ] **Step 2: Write the island-predicate test**

Create `web/src/lib/lens.test.ts`:
```ts
import { test, expect } from 'vitest'
import { keepEvent } from './lens'
import type { TimelineEntry } from './types'

const entry = (authorId: string): TimelineEntry => ({ id: 'p', title: null, content: 'x', url: null, publishedAt: '', source: 'remote', author: { id: authorId, handle: 'h', displayName: 'H', kind: 'remote' } })

test('author lens keeps only the matching author', () => {
  expect(keepEvent(entry('a'), { kind: 'author', authorId: 'a' })).toBe(true)
  expect(keepEvent(entry('b'), { kind: 'author', authorId: 'a' })).toBe(false)
})

test('followed lens keeps only authors in the follow set', () => {
  const lens = { kind: 'followed' as const, followIds: new Set(['a', 'b']) }
  expect(keepEvent(entry('a'), lens)).toBe(true)
  expect(keepEvent(entry('c'), lens)).toBe(false)
})
```

- [ ] **Step 3: Run — verify it fails, then implement**

Run: `npm test -w web`
Expected: FAIL — cannot resolve `./lens`.

Create `web/src/lib/lens.ts`:
```ts
import type { TimelineEntry } from './types'

export type Lens =
  | { kind: 'author'; authorId: string }
  | { kind: 'followed'; followIds: Set<string> }

export function keepEvent(entry: TimelineEntry, lens: Lens): boolean {
  if (lens.kind === 'author') return entry.author.id === lens.authorId
  return lens.followIds.has(entry.author.id)
}
```

- [ ] **Step 4: Extend the api client**

In `web/src/lib/api.ts`, replace `getTimeline` with a filter-aware version and add the follow/OPML client functions:
```ts
export async function getTimeline(
  f: typeof fetch,
  opts: { before?: string; followedBy?: string; author?: string } = {}
): Promise<TimelinePage> {
  // Build the query manually with encodeURIComponent — NOT URLSearchParams.
  // The cursor wire format is `<publishedAt>~<id>`; URLSearchParams'
  // form-encoding mangled it once already (found, fixed, revert rejected). P3.
  const url = new URL(`${base()}/timeline`)
  const params: string[] = []
  if (opts.before) params.push(`before=${encodeURIComponent(opts.before)}`)
  if (opts.followedBy) params.push(`followed_by=${encodeURIComponent(opts.followedBy)}`)
  if (opts.author) params.push(`author=${encodeURIComponent(opts.author)}`)
  if (params.length) url.search = params.join('&')
  const res = await f(url.toString())
  if (!res.ok) throw new Error(await errorMessage(res, `timeline ${res.status}`))
  const body = (await res.json()) as { timeline: TimelineEntry[]; nextCursor?: string | null }
  return { timeline: body.timeline, nextCursor: body.nextCursor ?? null }
}

export async function getFollowing(f: typeof fetch, handle: string): Promise<TimelineEntry['author'][]> {
  const res = await f(`${base()}/users/${encodeURIComponent(handle)}/follows`)
  if (!res.ok) throw new Error(await errorMessage(res, `following ${res.status}`))
  return (await res.json()).following
}

export async function addFollow(f: typeof fetch, handle: string, target: string): Promise<void> {
  const res = await f(`${base()}/users/${encodeURIComponent(handle)}/follows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
    body: JSON.stringify({ handle: target })
  })
  if (!res.ok) throw new Error(await errorMessage(res, `addFollow ${res.status}`))
}

export async function removeFollow(f: typeof fetch, handle: string, target: string): Promise<void> {
  const res = await f(`${base()}/users/${encodeURIComponent(handle)}/follows/${encodeURIComponent(target)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token()}` }
  })
  if (!res.ok) throw new Error(await errorMessage(res, `removeFollow ${res.status}`))
}

export async function importOpml(f: typeof fetch, handle: string, opml: string): Promise<{ followed: number; created: number; skipped: number }> {
  const res = await f(`${base()}/users/${encodeURIComponent(handle)}/follows/opml`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}` },
    body: opml
  })
  if (!res.ok) throw new Error(await errorMessage(res, `importOpml ${res.status}`))
  return res.json()
}
```

- [ ] **Step 5: Update the existing `getTimeline` call site**

In `web/src/routes/+page.server.ts`, change the load call from `getTimeline(fetch, before)` to `getTimeline(fetch, { before })`.

Then run `npm test -w web` — the existing `page.load.test.ts` / `api.test.ts` may assert the old positional call. If a test fails, update its expectation to the new opts-object shape (e.g. a mock asserting the fetched URL string, which is unchanged for the no-filter case). Expected after fix: PASS.

- [ ] **Step 6: Author lens route**

Create `web/src/routes/u/[handle]/+page.server.ts`:
```ts
import type { PageServerLoad } from './$types'
import { getTimeline } from '$lib/api'

export const load: PageServerLoad = async ({ fetch, params, url }) => {
  const before = url.searchParams.get('before') ?? undefined
  const isFirstPage = !before
  try {
    const { timeline, nextCursor } = await getTimeline(fetch, { before, author: params.handle })
    return { handle: params.handle, timeline, nextCursor, isFirstPage }
  } catch {
    return { handle: params.handle, timeline: [], nextCursor: null, isFirstPage, coreDown: true }
  }
}
```

Create `web/src/routes/u/[handle]/+page.svelte`:
```svelte
<script lang="ts">
  import type { PageData } from './$types'
  import type { TimelineEntry } from '$lib/types'
  import LiveTimeline from '$lib/LiveTimeline.svelte'
  import { keepEvent } from '$lib/lens'
  import { plaintext } from '$lib/plaintext'

  let { data }: { data: PageData } = $props()
  const authorId = $derived(data.timeline[0]?.author.id ?? null)
  let live = $state<TimelineEntry[]>([])
  const posts = $derived([...live, ...data.timeline])
  function onPost(entry: TimelineEntry) {
    if (authorId && keepEvent(entry, { kind: 'author', authorId }) && !posts.some((p) => p.id === entry.id)) live = [entry, ...live]
  }
</script>

{#if data.isFirstPage && authorId}<LiveTimeline {onPost} />{/if}

<h1>@{data.handle}</h1>
{#if data.coreDown}<p role="alert">Core API unreachable.</p>{/if}
<ul class="timeline">
  {#each posts as post (post.id)}
    <li class="post" class:remote={post.source === 'remote'}>
      {#if post.title}<h2>{post.title}</h2>{/if}
      <p>{plaintext(post.content)}</p>
      {#if post.url}<a href={post.url} rel="noreferrer">source</a>{/if}
    </li>
  {/each}
</ul>
{#if data.nextCursor}<a href="/u/{data.handle}?before={encodeURIComponent(data.nextCursor)}">Older posts</a>{/if}
```

Note: the author-lens live filter uses the author id discovered from the first SSR row. If the lens is empty on load (`authorId === null`), the island stays off until a refresh populates a row — acceptable, matches the accepted staleness model.

- [ ] **Step 7: Followed lens route + forms**

Create `web/src/routes/u/[handle]/following/+page.server.ts`:
```ts
import type { PageServerLoad, Actions } from './$types'
import { fail } from '@sveltejs/kit'
import { getTimeline, getFollowing, addFollow, removeFollow, importOpml } from '$lib/api'

export const load: PageServerLoad = async ({ fetch, params, url }) => {
  const before = url.searchParams.get('before') ?? undefined
  const isFirstPage = !before
  try {
    const [{ timeline, nextCursor }, following] = await Promise.all([
      getTimeline(fetch, { before, followedBy: params.handle }),
      getFollowing(fetch, params.handle)
    ])
    return { handle: params.handle, timeline, nextCursor, isFirstPage, following, followIds: following.map((u) => u.id) }
  } catch {
    return { handle: params.handle, timeline: [], nextCursor: null, isFirstPage, following: [], followIds: [], coreDown: true }
  }
}

export const actions = {
  follow: async ({ request, fetch, params }) => {
    const target = String((await request.formData()).get('target') ?? '').trim().toLowerCase()
    if (!target) return fail(400, { error: 'target handle is required' })
    try { await addFollow(fetch, params.handle, target) } catch (err) { return fail(400, { error: err instanceof Error ? err.message : 'follow failed' }) }
    return { ok: true }
  },
  unfollow: async ({ request, fetch, params }) => {
    const target = String((await request.formData()).get('target') ?? '').trim().toLowerCase()
    try { await removeFollow(fetch, params.handle, target) } catch (err) { return fail(400, { error: err instanceof Error ? err.message : 'unfollow failed' }) }
    return { ok: true }
  },
  import: async ({ request, fetch, params }) => {
    const file = (await request.formData()).get('opml')
    if (!(file instanceof File)) return fail(400, { error: 'choose an OPML file' })
    try {
      const result = await importOpml(fetch, params.handle, await file.text())
      return { ok: true, result }
    } catch (err) { return fail(400, { error: err instanceof Error ? err.message : 'import failed' }) }
  }
} satisfies Actions
```

Create `web/src/routes/u/[handle]/following/+page.svelte`:
```svelte
<script lang="ts">
  import type { PageData, ActionData } from './$types'
  import type { TimelineEntry } from '$lib/types'
  import LiveTimeline from '$lib/LiveTimeline.svelte'
  import { keepEvent } from '$lib/lens'
  import { plaintext } from '$lib/plaintext'

  let { data, form }: { data: PageData; form: ActionData } = $props()
  const followSet = $derived(new Set(data.followIds))
  let live = $state<TimelineEntry[]>([])
  const posts = $derived([...live, ...data.timeline])
  function onPost(entry: TimelineEntry) {
    if (keepEvent(entry, { kind: 'followed', followIds: followSet }) && !posts.some((p) => p.id === entry.id)) live = [entry, ...live]
  }
</script>

{#if data.isFirstPage}<LiveTimeline {onPost} />{/if}

<h1>@{data.handle} — following</h1>
{#if data.coreDown}<p role="alert">Core API unreachable.</p>{/if}
{#if form?.error}<p role="alert">{form.error}</p>{/if}
{#if form?.result}<p>Imported: {form.result.followed} followed, {form.result.created} created, {form.result.skipped} skipped.</p>{/if}

<form method="POST" action="?/follow">
  <input name="target" placeholder="handle to follow" required />
  <button>Follow</button>
</form>

<form method="POST" action="?/import" enctype="multipart/form-data">
  <input type="file" name="opml" accept=".opml,.xml,text/xml" required />
  <button>Import OPML</button>
</form>

<p><a href="/users/{data.handle}/following.opml">Export OPML</a> · <a href="/u/{data.handle}">author lens</a></p>

<h2>Following</h2>
<ul>
  {#each data.following as u (u.id)}
    <li>
      <a href="/u/{u.handle}">@{u.handle}</a> ({u.kind})
      <form method="POST" action="?/unfollow" style="display:inline">
        <input type="hidden" name="target" value={u.handle} />
        <button>Unfollow</button>
      </form>
    </li>
  {/each}
</ul>

<ul class="timeline">
  {#each posts as post (post.id)}
    <li class="post" class:remote={post.source === 'remote'}>
      <a href="/u/{post.author.handle}">@{post.author.handle}</a>
      {#if post.title}<h3>{post.title}</h3>{/if}
      <p>{plaintext(post.content)}</p>
    </li>
  {/each}
</ul>
{#if data.nextCursor}<a href="/u/{data.handle}/following?before={encodeURIComponent(data.nextCursor)}">Older posts</a>{/if}
```

Note the Export OPML link points at the core route path `/users/<h>/following.opml`. Since `web/` proxies core over HTTP, add a passthrough route if core isn't publicly reachable from the browser — but in the current single-origin dev setup the core origin is not browser-facing, so instead link to a tiny SvelteKit proxy: create `web/src/routes/u/[handle]/following.opml/+server.ts` mirroring `stream/+server.ts` if the browser can't reach core directly. For the dev setup where the export is fetched server-side, keep the link as a plain anchor and document that production needs the proxy (same pattern as the SSE `/stream` proxy). **Decision for this task:** add the proxy now for parity:

Create `web/src/routes/u/[handle]/following.opml/+server.ts`:
```ts
import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

export const GET: RequestHandler = async ({ params, fetch }) => {
  const upstream = await fetch(`${base()}/users/${encodeURIComponent(params.handle)}/following.opml`)
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'text/xml; charset=utf-8' }
  })
}
```
And change the export link `href` to `/u/{data.handle}/following.opml`.

- [ ] **Step 8: Run web gates**

Run: `npm test -w web && npm run check -w web`
Expected: PASS; svelte-check 0 errors. (If `page.load.test.ts` / `api.test.ts` reference the old `getTimeline` positional signature, update them to the opts-object form — the fetched URL is unchanged for the no-filter case.)

- [ ] **Step 9: Manual no-JS + live check**

Run core (`TEXTCASTER_TOKEN=dev npm run dev -w core`) + web (`npm run dev -w web`). With JS disabled: open `/u/<handle>` and `/u/<handle>/following`, submit the follow form → the following list grows on reload; the OPML import form accepts a file and reports counts. With JS on: a new post by a followed author appears live on the following lens without refresh; a post by a non-followed author does not.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "$(printf 'web: author + followed lens pages, follow UI, OPML import/export, live filtering\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 9: RUNNING.md + whole-milestone gates

**Files:**
- Modify: `docs/superpowers/documentation/RUNNING.md`

- [ ] **Step 1: Document the following feature**

Add a "Following & lenses" section to `docs/superpowers/documentation/RUNNING.md`: the two lens URLs (`/u/<handle>`, `/u/<handle>/following`), the follow/unfollow/OPML-import forms, the export link, and a note that imported feeds are picked up by the poller on its next cycle (no synchronous fetch). Mention the `followed_by`/`author` query params on `GET /timeline` and the OPML routes for API consumers.

- [ ] **Step 2: Full suite**

Run:
```bash
npm test -w core && npm run typecheck -w core && npm test -w web && npm run check -w web
```
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "$(printf 'docs: running guide — following, lenses, OPML both ways\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** migration 4 + follows table → Task 1; three repo methods → Task 1; `getTimeline` filter → Task 2; service local-follower rule + lens passthrough → Task 3; follow/unfollow/list routes + lens query params (both→400, unknown→404, remote-author lens) → Task 4; OPML export (both minted URLs, local omission without PUBLIC_URL) → Task 5; OPML import (recursive flatten H1, feed.json self-detection H2, slug collision H3, 1000-outline cap H5, skip accounting) → Task 6; money/round-trip test → Task 7; web lenses + forms + island filtering (both-direction staleness H6 accepted, no refetch loop) → Task 8; RUNNING.md → Task 9. `posts_author_pub_idx` ships in Task 1's migration. Non-goals (mute/block/counts/reverse-query/private lenses/SSE change) appear nowhere. ✅
- **Repo-method note:** import case 1 needs no new repository method — `listRemoteUsers()` (existing) indexes every remote feedUrl into a `Map`, and case 2 parses the handle from the minted URL and uses the existing `getUserByHandle`. This keeps the plan inside the spec's enumerated repo surface exactly. ✅
- **Placeholder scan:** every code step has complete code; Task 8's markup is functional (design-system pass refines styling, flagged). No TBD/TODO.
- **Type consistency:** `getTimeline(limit, before?, filter?)` filter shape `{ followedBy?; authorId? }` identical across repository.ts (Task 1/2), sqlite.ts (Task 2), service.ts (Task 3), app.ts (Task 4). `addFollow(follower: User, target: User)` in service (Task 3) matches the API call in Task 4 and the import deps in Task 6. Web wire `author.id` added in Task 8 Step 1 before any consumer uses it. `importFollowingOpml` deps object identical between the Task 6 test, implementation, and the Task 6 route wiring.
- **Known accepted (from the review, carried):** the `followed_by` lens is not index-ordered by `posts_author_pub_idx` (it scans `posts_published_idx` filtered) — correct and fine at spine scale; the index serves the `author` lens directly. No task claims otherwise.
- **Plan-review fixes applied (P1–P3):** P1 — import validates `xmlUrl` scheme via `isHttpUrl` in Task 6 (the service layer does no URL validation; only the `POST /users` route did), with a garbage-URL test. P2 — `listFollowing` orders `created_at ASC, handle ASC` (deterministic same-ms tiebreak), Task 1 test expectation aligned to `['blog','news']`. P3 — Task 8's web `getTimeline` builds the query with manual `encodeURIComponent`, not `URLSearchParams.set`, preserving the `~`-separated cursor wire format (a previously-fixed, revert-rejected bug).
- **Deferred to task review (minor, non-blocking):** (a) the lens pages' `catch` maps a 404 unknown-handle to "Core API unreachable" — a status check would distinguish "no such user"; (b) no explicit v3→v4 migration upgrade test, though the runner is generic and 1→2/2→3 are already pinned. Flag both at the relevant task's review.
