# Textcaster Debt Batch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the four debt designs — `user_version` migrations, cursor pagination end to end, SSE reconnect replay in arrival order, duplicate-handle adapter contract — plus the mechanical minors, per the approved spec.

**Architecture:** All core work stays behind the existing boundaries: migrations are SQLite-private (the `Repository` interface never learns they exist); pagination and replay are two predicates over two orderings — display `(published_at, id)`, arrival `created_at` — pinned in the adapter-neutral contract suite; the web app consumes only the HTTP surface. Replay is inclusive on `created_at` with no id tiebreak (same-ms batches re-deliver; clients dedup by id).

**Tech Stack:** Existing only — TypeScript/ESM, Kysely + better-sqlite3, Hono, Vitest, SvelteKit. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-15-textcaster-debt-batch-design.md` (rev 3). Review context: `docs/superpowers/reviews/2026-07-15-debt-batch-spec-review.md` and `docs/superpowers/reviews/2026-07-15-debt-batch-plan-review.md` (M1/D1 and polish applied in this revision).

## Global Constraints

- TypeScript, ESM everywhere. No new dependencies.
- Storage-agnostic core: no Kysely/SQLite outside `core/src/storage/`; the contract suite exercises only the `Repository` interface.
- `web/` never imports from `core/`; it owns its wire types.
- TDD: failing test first, then minimal code. Run `npm test -w core` (or `-w web`) at each RED/GREEN checkpoint.
- Fail-fast migration policy: valid current-schema spine DBs (user_version 0) are intentionally rejected — do NOT add schema sniffing.
- Replay is inclusive (`created_at >= cursor`), no id tiebreak; double-delivery is by design (clients dedup by id). Do not "optimize" it back to exclusive.
- `HandleTakenError` detection: `code === 'SQLITE_CONSTRAINT_UNIQUE'` only, no message parsing.
- Do NOT build: streaming ingest body cap, per-post emitted-live marker, replay beyond the 100-cap, client-side frame sorting (R2: interleave is accepted).
- Commit after each task; end every commit message with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File structure (touched by this batch)

```
core/src/storage/sqlite.ts        # migrations + runner; cursor/replay queries; HandleTakenError rethrow
core/src/domain/types.ts          # TimelineCursor, HandleTakenError
core/src/domain/repository.ts     # getTimeline(limit, before?), getTimelineAfter, getPost
core/src/domain/repository-contract.ts  # new pins (pagination, replay, dup-handle)
core/src/domain/service.ts        # guard changes (H7/H8), passthroughs
core/src/domain/ingest.ts         # fallbackGuid '\0', sniff-only JSON
core/src/api/cursor.ts            # NEW: parse/format wire cursor
core/src/api/app.ts               # /timeline params + nextCursor; SSE replay; displayName fallback
core/src/config.ts                # numeric guards
core/test/migrations.test.ts      # NEW
docs/superpowers/documentation/RUNNING.md  # stale-DB section rewrite
web/src/routes/stream/+server.ts  # forward Last-Event-ID; content-type on OK only
web/src/lib/api.ts                # TimelinePage, error surfacing, before param
web/src/routes/+page.server.ts    # ?before= + isFirstPage
web/src/routes/+page.svelte       # Older-posts link; island gating
(+ their existing test files)
```

---

### Task 1: Migration runner + migration 1

**Files:**
- Modify: `core/src/storage/sqlite.ts:69-95` (replace `createSqliteRepository`'s bootstrap)
- Create: `core/test/migrations.test.ts`
- Modify: `docs/superpowers/documentation/RUNNING.md` (the `## Stale DB warning` section)

**Interfaces:**
- Consumes: current `createSqliteRepository(filename)` and `SqliteRepository` (unchanged class).
- Produces: same `createSqliteRepository(filename): Promise<SqliteRepository>` signature; DBs it opens have `PRAGMA user_version = 1`. Throws `Error(/pre-migration database/)` on version-0-with-tables, `Error(/newer than this build/)` on future versions. Migration 1 creates composite indexes `posts_published_idx (published_at, id)` and `posts_created_idx (created_at, id)` that Tasks 2/5 rely on.

- [ ] **Step 1: Write the failing tests**

`core/test/migrations.test.ts`:
```ts
import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteRepository } from '../src/storage/sqlite.ts'

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'txc-mig-')), 'test.db')
}

test('a fresh database migrates to the current version and works', async () => {
  const file = tempDb()
  const repo = await createSqliteRepository(file)
  const u = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  expect((await repo.getTimeline(10)).length).toBe(0)
  expect(u.handle).toBe('alice')
  const raw = new Database(file, { readonly: true })
  expect(raw.pragma('user_version', { simple: true })).toBe(1)
  raw.close()
})

test('reopening an already-current database is a no-op', async () => {
  const file = tempDb()
  const first = await createSqliteRepository(file)
  await first.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  const second = await createSqliteRepository(file)
  expect((await second.getUserByHandle('alice'))?.handle).toBe('alice')
})

test('a version-0 database that already has tables fails fast', async () => {
  const file = tempDb()
  const raw = new Database(file)
  raw.exec('CREATE TABLE users (id text)')
  raw.close()
  await expect(createSqliteRepository(file)).rejects.toThrow(/pre-migration database/)
})

test('a database stamped newer than this build fails fast', async () => {
  const file = tempDb()
  const raw = new Database(file)
  raw.pragma('user_version = 99')
  raw.close()
  await expect(createSqliteRepository(file)).rejects.toThrow(/newer than this build/)
})
```

- [ ] **Step 2: Run — verify the new tests fail**

Run: `npm test -w core`
Expected: FAIL — fresh-DB test fails on `user_version` = 0 (bootstrap never stamps it); fail-fast tests fail because no error is thrown.

- [ ] **Step 3: Implement the runner + migration 1**

In `core/src/storage/sqlite.ts`, replace the entire `createSqliteRepository` function (current lines 69-95) with:

```ts
// index N-1 holds the statements that bring the schema to version N.
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE users (
      id text PRIMARY KEY,
      kind text NOT NULL,
      handle text NOT NULL UNIQUE,
      display_name text NOT NULL,
      feed_url text,
      created_at text NOT NULL
    )`,
    `CREATE TABLE posts (
      id text PRIMARY KEY,
      author_id text NOT NULL REFERENCES users(id),
      source text NOT NULL,
      guid text NOT NULL,
      title text,
      content text NOT NULL,
      url text,
      published_at text NOT NULL,
      created_at text NOT NULL,
      CONSTRAINT posts_author_guid_uq UNIQUE (author_id, guid)
    )`,
    'CREATE INDEX posts_published_idx ON posts (published_at, id)',
    'CREATE INDEX posts_created_idx ON posts (created_at, id)',
  ],
]

function migrate(sqlite: InstanceType<typeof Database>): void {
  const version = sqlite.pragma('user_version', { simple: true }) as number
  if (version > MIGRATIONS.length) {
    throw new Error(`database is newer than this build (version ${version}, this build knows ${MIGRATIONS.length})`)
  }
  if (version === 0) {
    const { n } = sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }
    // Intentionally rejects valid current-schema spine DBs too: everything
    // created before the migration era has user_version = 0, and we do not
    // sniff the schema to grandfather them in. Deletion is the designed outcome.
    if (n > 0) throw new Error('pre-migration database — delete it (dev data only) and restart')
  }
  for (let v = version + 1; v <= MIGRATIONS.length; v++) {
    sqlite.transaction(() => {
      for (const stmt of MIGRATIONS[v - 1]) sqlite.exec(stmt)
      sqlite.pragma(`user_version = ${v}`)
    })()
  }
}

export async function createSqliteRepository(filename: string): Promise<SqliteRepository> {
  const sqlite = new Database(filename)
  sqlite.pragma('foreign_keys = ON')
  migrate(sqlite)
  const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) })
  return new SqliteRepository(db)
}
```

(The Kysely `db.schema.createTable/createIndex` bootstrap is deleted. Everything above `createSqliteRepository` — table interfaces, `rowToUser`, the `SqliteRepository` class — is unchanged. The named `CONSTRAINT posts_author_guid_uq` keeps the existing comment at `sqlite.ts:42-43` accurate.)

- [ ] **Step 4: Run — verify everything passes**

Run: `npm test -w core`
Expected: PASS — 4 new migration tests plus the whole existing suite (contract/service/ingest/api/sse all ride on `createSqliteRepository(':memory:')`, which now migrates instead of bootstrapping).

- [ ] **Step 5: Update RUNNING.md**

In `docs/superpowers/documentation/RUNNING.md`, replace the body of the `## Stale DB warning` section (keep the heading) with:

```markdown
**Schema changes are now migration-gated.** Core refuses to start against a
database it cannot handle, with a clear error instead of silent 500s:

- `pre-migration database — delete it (dev data only) and restart` — the file
  predates the migration system. **The first boot after this change will say
  exactly that for every existing dev DB, including freshly recreated
  spine-era ones.** Delete it:

  ```bash
  rm -f core/data/textcaster.db
  ```

- `database is newer than this build` — the file was created by a newer
  checkout; update your checkout (or delete the dev DB).

From now on, schema upgrades apply automatically at startup.
```

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck -w core`
Expected: exit 0.

```bash
git add core/src/storage/sqlite.ts core/test/migrations.test.ts docs/superpowers/documentation/RUNNING.md
git commit -m "$(printf 'core: user_version migrations, fail-fast on unversioned or future DBs\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 2: Repository cursor + replay primitives + contract pins

**Files:**
- Modify: `core/src/domain/types.ts` (add `TimelineCursor`)
- Modify: `core/src/domain/repository.ts`
- Modify: `core/src/storage/sqlite.ts` (queries)
- Modify: `core/src/domain/repository-contract.ts` (new tests)

**Interfaces:**
- Consumes: Task 1's schema (composite indexes exist; no schema change here).
- Produces (exact signatures later tasks rely on):
  - `interface TimelineCursor { publishedAt: string; id: string }` (in `types.ts`)
  - `getTimeline(limit: number, before?: TimelineCursor): Promise<TimelineEntry[]>`
  - `getTimelineAfter(sinceCreatedAt: string, limit: number): Promise<TimelineEntry[]>` — inclusive `created_at >= sinceCreatedAt`, ordered `created_at ASC, id ASC`. May include the anchor post itself; consumers dedup by id.
  - `getPost(id: string): Promise<Post | undefined>`

- [ ] **Step 1: Write the failing contract tests**

Append inside the `describe('Repository contract', ...)` block in `core/src/domain/repository-contract.ts` (match the file's existing style — no semicolons, single quotes):

```ts
    test('getTimeline pages with a before cursor: page 2 starts where page 1 ended', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      for (let i = 1; i <= 3; i++) {
        await repo.insertPost({ id: `p${i}`, authorId: a.id, source: 'local', guid: `g${i}`, title: null, content: `post ${i}`, url: null, publishedAt: `2026-01-0${i}T00:00:00.000Z`, createdAt: `2026-01-0${i}T00:00:00.000Z` })
      }
      const page1 = await repo.getTimeline(2)
      expect(page1.map((e) => e.id)).toEqual(['p3', 'p2'])
      const last = page1[page1.length - 1]
      const page2 = await repo.getTimeline(2, { publishedAt: last.publishedAt, id: last.id })
      expect(page2.map((e) => e.id)).toEqual(['p1'])
    })

    test('getTimeline splits publishedAt ties by id across pages', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const t = '2026-01-01T00:00:00.000Z'
      await repo.insertPost({ id: 'aaa', authorId: a.id, source: 'local', guid: 'g-aaa', title: null, content: 'tie low', url: null, publishedAt: t, createdAt: t })
      await repo.insertPost({ id: 'zzz', authorId: a.id, source: 'local', guid: 'g-zzz', title: null, content: 'tie high', url: null, publishedAt: t, createdAt: t })
      const page1 = await repo.getTimeline(1)
      expect(page1[0].id).toBe('zzz')
      const page2 = await repo.getTimeline(1, { publishedAt: t, id: 'zzz' })
      expect(page2[0].id).toBe('aaa')
    })

    test('getTimelineAfter returns arrival order, inclusive of the anchor timestamp', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      // anchor: arrived first, displays newest (published latest)
      await repo.insertPost({ id: 'anchor', authorId: a.id, source: 'local', guid: 'g-anchor', title: null, content: 'anchor', url: null, publishedAt: '2026-01-10T12:00:00.000Z', createdAt: '2026-01-10T12:00:00.000Z' })
      // same-created_at sibling (R1 case)
      await repo.insertPost({ id: 'sibling', authorId: a.id, source: 'local', guid: 'g-sibling', title: null, content: 'sibling', url: null, publishedAt: '2026-01-10T12:00:00.000Z', createdAt: '2026-01-10T12:00:00.000Z' })
      // arrived later but published in the past (H1 case)
      await repo.insertPost({ id: 'olddate', authorId: a.id, source: 'remote', guid: 'g-old', title: null, content: 'old-dated', url: null, publishedAt: '2020-01-01T00:00:00.000Z', createdAt: '2026-01-10T12:00:01.000Z' })
      const replay = await repo.getTimelineAfter('2026-01-10T12:00:00.000Z', 10)
      expect(replay.map((e) => e.id)).toEqual(['anchor', 'sibling', 'olddate'])
      expect(replay[0].author.handle).toBe('alice')
    })

    test('getPost returns a post by id and undefined for unknown ids', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      await repo.insertPost({ id: 'p1', authorId: a.id, source: 'local', guid: 'g1', title: null, content: 'x', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
      expect((await repo.getPost('p1'))?.guid).toBe('g1')
      expect(await repo.getPost('nope')).toBeUndefined()
    })
```

- [ ] **Step 2: Run — verify it fails**

Run: `npm test -w core`
Expected: FAIL at runtime (vitest does not typecheck): `TypeError: repo.getTimelineAfter is not a function`, `TypeError: repo.getPost is not a function`, and the pagination tests fail because `getTimeline` ignores its second argument.

- [ ] **Step 3: Implement types, interface, and queries**

`core/src/domain/types.ts` — append:
```ts
export interface TimelineCursor { publishedAt: string; id: string }
```

`core/src/domain/repository.ts` — replace the whole file:
```ts
import type { User, Post, NewLocalUser, NewRemoteUser, TimelineEntry, TimelineCursor } from './types.ts'

export interface Repository {
  createLocalUser(u: NewLocalUser): Promise<User>
  createRemoteUser(u: NewRemoteUser): Promise<User>
  getUser(id: string): Promise<User | undefined>
  getUserByHandle(handle: string): Promise<User | undefined>
  listRemoteUsers(): Promise<User[]>
  insertPost(p: Post): Promise<boolean>
  hasPostsByAuthor(authorId: string): Promise<boolean>
  getTimeline(limit: number, before?: TimelineCursor): Promise<TimelineEntry[]>
  /** Arrival-order replay scan: created_at >= sinceCreatedAt, ASC. Inclusive by
   *  design (same-ms batches re-deliver in full); consumers dedup by id. */
  getTimelineAfter(sinceCreatedAt: string, limit: number): Promise<TimelineEntry[]>
  getPost(id: string): Promise<Post | undefined>
}
```

`core/src/storage/sqlite.ts` — inside `SqliteRepository`:

Add a row mapper next to `rowToUser` (module level):
```ts
function rowToPost(r: PostsTable): Post {
  return { id: r.id, authorId: r.author_id, source: r.source, guid: r.guid, title: r.title, content: r.content, url: r.url, publishedAt: r.published_at, createdAt: r.created_at }
}
```

Replace `getTimeline` and add the two new methods:
```ts
  async getTimeline(limit: number, before?: TimelineCursor): Promise<TimelineEntry[]> {
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
    const rows = await q.execute()
    return rows.map(joinedRowToEntry)
  }

  async getTimelineAfter(sinceCreatedAt: string, limit: number): Promise<TimelineEntry[]> {
    const rows = await this.db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .selectAll('posts')
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at'])
      .where('posts.created_at', '>=', sinceCreatedAt)
      .orderBy('posts.created_at', 'asc')
      .orderBy('posts.id', 'asc')
      .limit(limit)
      .execute()
    return rows.map(joinedRowToEntry)
  }

  async getPost(id: string): Promise<Post | undefined> {
    const r = await this.db.selectFrom('posts').selectAll().where('id', '=', id).executeTakeFirst()
    return r ? rowToPost(r) : undefined
  }
```

Both methods map rows identically — extract the existing inline mapping from `getTimeline` into a module-level helper and use it in both places:
```ts
type JoinedRow = PostsTable & { u_id: string; u_kind: 'local' | 'remote'; u_handle: string; u_display_name: string; u_feed_url: string | null; u_created_at: string }

function joinedRowToEntry(r: JoinedRow): TimelineEntry {
  return {
    ...rowToPost(r),
    author: { id: r.u_id, kind: r.u_kind, handle: r.u_handle, displayName: r.u_display_name, feedUrl: r.u_feed_url, createdAt: r.u_created_at },
  }
}
```
Update the imports line in `sqlite.ts` to include `TimelineCursor`:
```ts
import type { User, Post, NewLocalUser, NewRemoteUser, TimelineEntry, TimelineCursor } from '../domain/types.ts'
```

- [ ] **Step 4: Run — verify it passes**

Run: `npm test -w core`
Expected: PASS — 4 new contract tests + full suite. If `eb.refTuple`/`eb.tuple` typing fights you, read the installed API first: `node_modules/kysely/dist/esm/expression/expression-builder.d.ts` (the spec review verified kysely 0.27.6 supports row-value comparison natively — do not fall back to raw SQL).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck -w core`
Expected: exit 0.

```bash
git add core/src/domain/types.ts core/src/domain/repository.ts core/src/domain/repository-contract.ts core/src/storage/sqlite.ts
git commit -m "$(printf 'core: cursor pagination + arrival-order replay scan in the Repository contract\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 3: HandleTakenError — adapter contract + service guard changes

**Files:**
- Modify: `core/src/domain/types.ts` (add error class)
- Modify: `core/src/storage/sqlite.ts:18-22` (`insertUser` rethrow)
- Modify: `core/src/domain/repository-contract.ts` (pin both kinds)
- Modify: `core/src/domain/service.ts` (delete one guard, keep one, add retry)
- Modify: `core/test/service.test.ts` (race-retry test)

**Interfaces:**
- Consumes: `DomainError` (exists in `types.ts`), `insertUser` private helper in the adapter.
- Produces: `export class HandleTakenError extends DomainError {}` — adapters MUST throw it (message `'handle already taken'`) from `createLocalUser`/`createRemoteUser` on a taken handle. Service behavior unchanged from the API's point of view (400s stay 400s).

- [ ] **Step 1: Write the failing contract tests**

Append inside the describe block in `core/src/domain/repository-contract.ts`, and add the import at the top of the file:
```ts
import { HandleTakenError } from './types.ts'
```
```ts
    test('creating a user with a taken handle throws HandleTakenError (both kinds)', async () => {
      const repo = await makeRepo()
      await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      await expect(repo.createLocalUser({ handle: 'alice', displayName: 'Alice 2' })).rejects.toThrow(HandleTakenError)
      await expect(repo.createRemoteUser({ handle: 'alice', displayName: 'A', feedUrl: 'https://ex.com/f.xml' })).rejects.toThrow(HandleTakenError)
    })
```

- [ ] **Step 2: Run — verify it fails**

Run: `npm test -w core`
Expected: FAIL — the adapter currently leaks better-sqlite3's raw `SqliteError`, not `HandleTakenError` (import error first if the class doesn't exist yet — add the class, then see the behavioral failure).

- [ ] **Step 3: Implement the error class + adapter rethrow**

`core/src/domain/types.ts` — below `DomainError`:
```ts
export class HandleTakenError extends DomainError {}
```

`core/src/storage/sqlite.ts` — add to the domain imports:
```ts
import { HandleTakenError } from '../domain/types.ts'
```
Replace the private `insertUser` method:
```ts
  private async insertUser(kind: 'local' | 'remote', handle: string, displayName: string, feedUrl: string | null): Promise<User> {
    const row: UsersTable = { id: randomUUID(), kind, handle, display_name: displayName, feed_url: feedUrl, created_at: new Date().toISOString() }
    try {
      await this.db.insertInto('users').values(row).execute()
    } catch (err) {
      // In the createUser paths the only reachable UNIQUE constraint is users.handle (ids are fresh UUIDs).
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new HandleTakenError('handle already taken')
      throw err
    }
    return rowToUser(row)
  }
```

- [ ] **Step 4: Run — verify the contract test passes**

Run: `npm test -w core`
Expected: PASS.

- [ ] **Step 5: Write the failing race-retry test (H7)**

Append to `core/test/service.test.ts` (imports to add at top: `import type { Repository } from '../src/domain/repository.ts'`):
```ts
test('a first post that loses the create race retries the lookup and succeeds', async () => {
  const repo = await createSqliteRepository(':memory:')
  await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' }) // the "winner" of the race
  let firstLookup = true
  const racy: Repository = {
    createLocalUser: (u) => repo.createLocalUser(u),
    createRemoteUser: (u) => repo.createRemoteUser(u),
    getUser: (id) => repo.getUser(id),
    getUserByHandle: async (h) => {
      if (firstLookup) { firstLookup = false; return undefined } // simulate pre-race view
      return repo.getUserByHandle(h)
    },
    listRemoteUsers: () => repo.listRemoteUsers(),
    insertPost: (p) => repo.insertPost(p),
    hasPostsByAuthor: (a) => repo.hasPostsByAuthor(a),
    getTimeline: (l, b) => repo.getTimeline(l, b),
    getTimelineAfter: (s, l) => repo.getTimelineAfter(s, l),
    getPost: (id) => repo.getPost(id),
  }
  const svc = createService(racy, createEventBus())
  const entry = await svc.createLocalPostAs('alice', 'Alice', 'raced post')
  expect(entry.author.handle).toBe('alice')
})
```

Run: `npm test -w core`
Expected: FAIL — `createLocalPostAs` rejects with `HandleTakenError` (no retry exists yet).

- [ ] **Step 6: Service guard changes (H7 + H8)**

`core/src/domain/service.ts`:

1. Update the error import:
```ts
import { DomainError, HandleTakenError } from './types.ts'
```
2. Replace `ensureLocalUser` (retry once on lost race; the found user still goes through the kind check):
```ts
  async function ensureLocalUser(handle: string, displayName: string): Promise<User> {
    const normalized = normalizeHandle(handle)
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await repo.getUserByHandle(normalized)
      if (existing) {
        if (existing.kind !== 'local') throw new DomainError('handle belongs to a remote user')
        return existing
      }
      try {
        return await repo.createLocalUser({ handle: normalized, displayName })
      } catch (err) {
        if (err instanceof HandleTakenError && attempt === 0) continue // lost the race; re-read
        throw err
      }
    }
    throw new DomainError('handle lookup raced') // unreachable in practice
  }
```
**KEEP the `'handle belongs to a remote user'` check above — deleting it would let anyone post as any remote user (the adapter never throws for an existing user because no insert happens).**

3. Replace `addRemoteUser` — the pre-check dies; the adapter's typed throw covers it race-free:
```ts
    async addRemoteUser(input: NewRemoteUser) {
      return repo.createRemoteUser({ ...input, handle: normalizeHandle(input.handle) })
    },
```

- [ ] **Step 7: Run — verify everything passes**

Run: `npm test -w core`
Expected: PASS — including the existing `service.test.ts` duplicate-remote-handle test and the existing `api.test.ts` duplicate-`POST /users`-→-400 test (`HandleTakenError extends DomainError`, so `app.onError` still maps it to 400 with the same message).

- [ ] **Step 8: Typecheck + commit**

Run: `npm run typecheck -w core`
Expected: exit 0.

```bash
git add core/src/domain/types.ts core/src/storage/sqlite.ts core/src/domain/repository-contract.ts core/src/domain/service.ts core/test/service.test.ts
git commit -m "$(printf 'core: HandleTakenError is adapter contract; race-free service guards\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 4: API cursor pagination (`?before=` + `nextCursor`)

**Files:**
- Create: `core/src/api/cursor.ts`
- Modify: `core/src/domain/service.ts:42-44` (`getTimeline` passthrough)
- Modify: `core/src/api/app.ts:65-68` (`GET /timeline`)
- Modify: `core/test/api.test.ts` (pagination tests)

**Interfaces:**
- Consumes: `repo.getTimeline(limit, before?)` (Task 2), `TimelineCursor` (Task 2).
- Produces:
  - `parseCursor(s: string): TimelineCursor | null` and `formatCursor(c: TimelineCursor): string` in `core/src/api/cursor.ts` (wire format `<publishedAt>~<id>`).
  - `service.getTimeline(limit?: number, before?: TimelineCursor)`.
  - `GET /timeline` response shape `{ timeline: TimelineEntry[], nextCursor: string | null }` — Task 8's web client consumes `nextCursor`.

- [ ] **Step 1: Write the failing API tests**

Append to `core/test/api.test.ts`:
```ts
test('timeline pages with before cursor: two pages cover all posts exactly once', async () => {
  const app = await makeApp()
  for (const content of ['one', 'two', 'three']) {
    await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ handle: 'alice', displayName: 'Alice', content }) })
  }
  const page1 = await (await app.request('/timeline?limit=2')).json()
  expect(page1.timeline.length).toBe(2)
  expect(typeof page1.nextCursor).toBe('string')
  const page2 = await (await app.request(`/timeline?before=${encodeURIComponent(page1.nextCursor)}&limit=2`)).json()
  expect(page2.nextCursor).toBeNull() // short page = no more
  const ids = [...page1.timeline, ...page2.timeline].map((e: { id: string }) => e.id)
  expect(new Set(ids).size).toBe(3) // disjoint union covers everything (robust to same-ms publishedAt ties)
})

test('timeline rejects a malformed before cursor', async () => {
  const app = await makeApp()
  expect((await app.request('/timeline?before=garbage')).status).toBe(400)
  expect((await app.request('/timeline?before=~missing-ts')).status).toBe(400)
})

test('timeline rejects a non-integer limit and clamps out-of-range limits', async () => {
  const app = await makeApp()
  expect((await app.request('/timeline?limit=abc')).status).toBe(400)
  expect((await app.request('/timeline?limit=0')).status).toBe(200) // clamped to 1
  expect((await app.request('/timeline?limit=5000')).status).toBe(200) // clamped to 100
})
```

Run: `npm test -w core`
Expected: FAIL — no `nextCursor` in the response; `?before=garbage` returns 200.

- [ ] **Step 2: Implement the cursor codec**

`core/src/api/cursor.ts`:
```ts
import type { TimelineCursor } from '../domain/types.ts'

// Wire format: <publishedAt>~<id>. '~' never appears in ISO-8601 dates or UUIDs.
export function formatCursor(c: TimelineCursor): string {
  return `${c.publishedAt}~${c.id}`
}

export function parseCursor(s: string): TimelineCursor | null {
  const i = s.indexOf('~')
  if (i <= 0 || i === s.length - 1) return null
  return { publishedAt: s.slice(0, i), id: s.slice(i + 1) }
}
```

- [ ] **Step 3: Service passthrough + route**

`core/src/domain/service.ts` — update the type import to include the cursor, and the passthrough:
```ts
import type { NewRemoteUser, TimelineEntry, TimelineCursor, User, Post } from './types.ts'
```
```ts
    getTimeline(limit = 100, before?: TimelineCursor) {
      return repo.getTimeline(limit, before)
    },
```

`core/src/api/app.ts` — add the import:
```ts
import { parseCursor, formatCursor } from './cursor.ts'
```
Replace the `GET /timeline` route:
```ts
  app.get('/timeline', async (c) => {
    const beforeRaw = c.req.query('before')
    let before
    if (beforeRaw !== undefined) {
      const parsed = parseCursor(beforeRaw)
      if (!parsed) return c.json({ error: 'before invalid' }, 400)
      before = parsed
    }
    const limitRaw = c.req.query('limit')
    let limit = 100
    if (limitRaw !== undefined) {
      const n = Number(limitRaw)
      if (!Number.isInteger(n)) return c.json({ error: 'limit invalid' }, 400)
      limit = Math.min(Math.max(n, 1), 100)
    }
    const timeline = await service.getTimeline(limit, before)
    const last = timeline[timeline.length - 1]
    // Known accepted edge: an exactly-limit final page yields a non-null cursor
    // whose next page is empty.
    const nextCursor = timeline.length === limit && last ? formatCursor({ publishedAt: last.publishedAt, id: last.id }) : null
    return c.json({ timeline, nextCursor })
  })
```

- [ ] **Step 4: Run — verify it passes**

Run: `npm test -w core`
Expected: PASS — new pagination tests plus the whole suite (the existing timeline test only reads `body.timeline[0]`, unaffected by the added `nextCursor` key).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck -w core`
Expected: exit 0.

```bash
git add core/src/api/cursor.ts core/src/api/app.ts core/src/domain/service.ts core/test/api.test.ts
git commit -m "$(printf 'core: timeline cursor pagination (?before= + nextCursor)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 5: SSE reconnect replay

**Files:**
- Modify: `core/src/domain/service.ts` (two passthroughs)
- Modify: `core/src/api/app.ts:70-76` (stream route)
- Modify: `core/test/sse.test.ts` (replay tests)

**Interfaces:**
- Consumes: `repo.getTimelineAfter(sinceCreatedAt, limit)` and `repo.getPost(id)` (Task 2); existing `streamSSE` route with `id:` frames.
- Produces: `service.getPost(id)`, `service.getTimelineAfter(sinceCreatedAt, limit)`; `GET /timeline/stream` honors the `Last-Event-ID` request header per spec §3 (subscribe-first, inclusive replay, 100-cap skip). Task 7's proxy relies on the header being honored.

- [ ] **Step 1: Write the failing replay tests**

Append to `core/test/sse.test.ts` (its existing test builds repo/bus/service/app inline — follow that pattern; `createSqliteRepository`, `createEventBus`, `createService`, `createApp` are already imported):

```ts
async function readUntil(res: Response, needle: string): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (!buf.includes(needle)) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value)
  }
  await reader.cancel()
  return buf
}

test('reconnect with Last-Event-ID replays missed posts (inclusive, arrival order) before live ones', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret' })

  const anchor = await service.createLocalPostAs('alice', 'Alice', 'anchor post')
  const news = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  // R1 case: same created_at as the anchor, different id
  await repo.insertPost({ id: 'sibling1', authorId: news.id, source: 'remote', guid: 'g-sib', title: null, content: 'same-ms sibling', url: null, publishedAt: anchor.createdAt, createdAt: anchor.createdAt })
  // H1 case: arrived after the anchor, published long before it
  const laterArrival = new Date(Date.parse(anchor.createdAt) + 5).toISOString()
  await repo.insertPost({ id: 'olddated1', authorId: news.id, source: 'remote', guid: 'g-old', title: null, content: 'old-dated missed', url: null, publishedAt: '2020-01-01T00:00:00.000Z', createdAt: laterArrival })

  const res = await app.request('/timeline/stream', { headers: { 'Last-Event-ID': anchor.id } })
  const buf = await readUntil(res, 'old-dated missed')
  expect(buf).toContain('same-ms sibling') // R1: sibling re-delivered despite equal created_at
  expect(buf).toContain('old-dated missed') // H1: old publishedAt does not hide it
  expect(buf.indexOf('same-ms sibling')).toBeLessThan(buf.indexOf('old-dated missed')) // arrival order
})

test('reconnect too stale (over the replay cap) skips replay but still goes live', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret' })

  const anchor = await service.createLocalPostAs('alice', 'Alice', 'anchor post')
  const base = Date.parse(anchor.createdAt)
  for (let i = 0; i < 101; i++) {
    const ts = new Date(base + i + 1).toISOString()
    await repo.insertPost({ id: `missed-${i}`, authorId: anchor.authorId, source: 'local', guid: `g-missed-${i}`, title: null, content: `missed ${i}`, url: null, publishedAt: ts, createdAt: ts })
  }

  const res = await app.request('/timeline/stream', { headers: { 'Last-Event-ID': anchor.id } })
  await new Promise((r) => setTimeout(r, 20))
  await service.createLocalPostAs('alice', 'Alice', 'live after stale reconnect')
  const buf = await readUntil(res, 'live after stale reconnect')
  expect(buf).not.toContain('missed 0') // no replay frames at all
})

test('an unknown Last-Event-ID skips replay silently and goes live', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret' })

  const res = await app.request('/timeline/stream', { headers: { 'Last-Event-ID': 'no-such-post' } })
  await new Promise((r) => setTimeout(r, 20))
  await service.createLocalPostAs('alice', 'Alice', 'live post')
  const buf = await readUntil(res, 'live post')
  expect(buf).toContain('event: post')
})
```

Run: `npm test -w core`
Expected: FAIL — replay tests time out / never see the missed frames (the route ignores `Last-Event-ID`); `TypeError: service.getPost is not a function` once the route references it before Step 2. (The existing SSE test also has a private read loop — leave it; the new `readUntil` helper is for the new tests.)

- [ ] **Step 2: Implement passthroughs + replay**

`core/src/domain/service.ts` — add to the returned object:
```ts
    getPost(id: string) {
      return repo.getPost(id)
    },
    getTimelineAfter(sinceCreatedAt: string, limit: number) {
      return repo.getTimelineAfter(sinceCreatedAt, limit)
    },
```

`core/src/api/app.ts` — add above `createApp`:
```ts
const REPLAY_CAP = 100
```
Replace the stream route:
```ts
  app.get('/timeline/stream', (c) =>
    streamSSE(c, async (stream) => {
      // Subscribe BEFORE replay (spec H2): a post landing between the replay
      // query and the subscription must not be lost. Double-delivery is fine —
      // clients dedup by id.
      const off = bus.onNewPost((entry) => { void stream.writeSSE({ event: 'post', id: entry.id, data: JSON.stringify(entry) }) })
      stream.onAbort(off)
      const lastEventId = c.req.header('Last-Event-ID')
      if (lastEventId) {
        const anchorPost = await service.getPost(lastEventId)
        if (anchorPost) {
          // Inclusive scan (spec R1): the anchor and its same-created_at batch
          // re-deliver in full; the cap count includes the anchor row.
          const missed = await service.getTimelineAfter(anchorPost.createdAt, REPLAY_CAP + 1)
          if (missed.length <= REPLAY_CAP) {
            for (const entry of missed) {
              await stream.writeSSE({ event: 'post', id: entry.id, data: JSON.stringify(entry) })
            }
          }
          // else: too stale for patch-up — skip replay entirely; SSR is the recovery path (spec H4).
        }
      }
      while (!stream.aborted) { await stream.sleep(15000); await stream.writeSSE({ event: 'ping', data: '' }) }
    }),
  )
```

- [ ] **Step 3: Run — verify it passes**

Run: `npm test -w core`
Expected: PASS — 3 new SSE tests + full suite.

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck -w core`
Expected: exit 0.

```bash
git add core/src/domain/service.ts core/src/api/app.ts core/test/sse.test.ts
git commit -m "$(printf 'core: SSE reconnect replay via Last-Event-ID (arrival order, capped)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 6: Core minors (config guards, displayName, guid separator, sniff-only, backfill pin)

**Files:**
- Modify: `core/src/config.ts`, `core/test/config.test.ts`
- Modify: `core/src/api/app.ts:48-50,59-61` (displayName fallback), `core/test/api.test.ts`
- Modify: `core/src/domain/ingest.ts:15-17,22-24,35-48` (separator, sniff), `core/test/ingest.test.ts`

**Interfaces:**
- Consumes: everything above; no interface changes visible to other tasks.
- Produces: `loadConfig` throws on non-numeric port/pollSeconds; both POST routes store `handle` as displayName when the sent one is blank; `fallbackGuid(title, content, rawDate)` hashes with `'\0'` separators; `parseFeed` decides JSON purely by body sniff (BOM-tolerant).

- [ ] **Step 1: Failing tests, all four behaviors**

Append to `core/test/config.test.ts`:
```ts
test('rejects a non-numeric port', () => {
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_PORT: 'abc' })).toThrow('TEXTCASTER_PORT')
})
test('rejects a non-numeric poll interval', () => {
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_POLL_SECONDS: 'soon' })).toThrow('TEXTCASTER_POLL_SECONDS')
})
```

Append to `core/test/api.test.ts`:
```ts
test('a blank displayName falls back to the handle', async () => {
  const app = await makeApp()
  await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ handle: 'alice', displayName: '   ', content: 'hi' }) })
  const body = await (await app.request('/timeline')).json()
  expect(body.timeline[0].author.displayName).toBe('alice')
})
```

Append to `core/test/ingest.test.ts` (uses the existing `fakeFetch` helper and imports in that file):
```ts
test('fallback guids for (ab,c) and (a,bc) do not collide', async () => {
  const json = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [
    { title: 'ab', content_text: 'c' },
    { title: 'a', content_text: 'bc' },
  ] })
  const items = await parseFeed(json, 'application/feed+json')
  expect(items[0].guid).not.toBe(items[1].guid)
})

test('an XML feed mislabeled as JSON still parses as RSS', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'mislabeled', displayName: 'M', feedUrl: 'https://ex.com/f' })
  const n = await ingestRemoteUser(repo, bus, user, fakeFetch(RSS, 'application/json'))
  expect(n).toBe(1)
})

test('a BOM-prefixed JSON Feed served as text/plain parses as JSON Feed', async () => {
  const json = '﻿' + JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [{ id: 'bom1', content_text: 'bom body' }] })
  const items = await parseFeed(json, 'text/plain')
  expect(items[0].guid).toBe('bom1')
})

test('backfill stays silent when the first sync was empty (pin, not a change)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'slowstart', displayName: 'S', feedUrl: 'https://ex.com/f.json' })
  const seen = vi.fn()
  bus.onNewPost(seen)
  const empty = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [] })
  expect(await ingestRemoteUser(repo, bus, user, fakeFetch(empty, 'application/feed+json'))).toBe(0)
  const two = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [
    { id: 's1', content_text: 'one' }, { id: 's2', content_text: 'two' },
  ] })
  expect(await ingestRemoteUser(repo, bus, user, fakeFetch(two, 'application/feed+json'))).toBe(2)
  expect(seen).toHaveBeenCalledTimes(0) // still backfill: nothing was ever live-visible
})
```
(If `parseFeed` is not yet imported in `ingest.test.ts`, add it to the existing import from `../src/domain/ingest.ts`.)

Run: `npm test -w core`
Expected: FAIL on four fronts — config tests (no guard), displayName test (blank stored as-is), guid-collision test (no separator), mislabeled-XML test (`JSON.parse` throws). The BOM test is a genuine RED too: `trimStart()` strips the BOM for the sniff, but `JSON.parse` still rejects the un-stripped body. Only the backfill-pin test may already pass — it is a pin, that is fine.

- [ ] **Step 2: Implement all four**

`core/src/config.ts` — replace the whole file:
```ts
export interface Config { dbPath: string; token: string; port: number; pollSeconds: number }

function positiveInt(name: string, raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`)
  return n
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.TEXTCASTER_TOKEN
  if (!token) throw new Error('TEXTCASTER_TOKEN is required')
  return {
    dbPath: env.TEXTCASTER_DB ?? './data/textcaster.db',
    token,
    port: positiveInt('TEXTCASTER_PORT', env.TEXTCASTER_PORT ?? '8787'),
    pollSeconds: positiveInt('TEXTCASTER_POLL_SECONDS', env.TEXTCASTER_POLL_SECONDS ?? '60'),
  }
}
```

`core/src/api/app.ts` — in BOTH `/users` and `/posts` routes, after the `displayName` validation line, compute the effective name and use it in the service call:
```ts
    const effectiveDisplayName = typeof displayName === 'string' && displayName.trim() !== '' ? displayName : handle
```
`/users`: `service.addRemoteUser({ handle, displayName: effectiveDisplayName, feedUrl })`
`/posts`: `service.createLocalPostAs(handle, effectiveDisplayName, content)`

`core/src/domain/ingest.ts`:

1. `fallbackGuid` — separator (H9 consequence — stored guidless/linkless items re-insert once on the first post-deploy poll; accepted):
```ts
function fallbackGuid(title: string | null, content: string, rawDate: string): string {
  return createHash('sha256').update((title ?? '') + '\0' + content + '\0' + rawDate).digest('hex')
}
```
2. Sniff-only detection — `parseFeed` drops the content-type disjunct and strips a BOM once at entry. Replace the function's opening lines (the BOM-stripped body is named `cleanBody` — do NOT name it `text`, which would shadow the per-item `text` const inside both branches):
```ts
export async function parseFeed(body: string, _contentType: string): Promise<ParsedItem[]> {
  const cleanBody = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body
  const now = new Date().toISOString()
  if (looksLikeJson(cleanBody)) {
    const feed = JSON.parse(cleanBody) as { items?: Array<Record<string, unknown>> }
```
…and the RSS branch parses `cleanBody` instead of `body` (`await rss.parseString(cleanBody)`). The content-type parameter stays in the signature for call-site compatibility but is now unused — rename it to `_contentType` as shown.

- [ ] **Step 3: Run — verify it passes**

Run: `npm test -w core`
Expected: PASS — full suite. The pre-existing ingest test that serves JSON with `content-type: application/feed+json` must still pass (body sniff catches it).

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck -w core`
Expected: exit 0.

```bash
git add core/src/config.ts core/test/config.test.ts core/src/api/app.ts core/test/api.test.ts core/src/domain/ingest.ts core/test/ingest.test.ts
git commit -m "$(printf 'core: config guards, displayName fallback, guid separator, sniff-only JSON detection\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 7: Web stream proxy — forward Last-Event-ID, honest error content-type

**Files:**
- Modify: `web/src/routes/stream/+server.ts`
- Modify: `web/src/routes/stream/server.test.ts`

**Interfaces:**
- Consumes: core's stream route honoring `Last-Event-ID` (Task 5).
- Produces: browser reconnects through `/stream` get replay for free (EventSource sends the header automatically; the proxy now forwards it). Error responses keep the upstream content-type.

- [ ] **Step 1: Failing tests**

Append to `web/src/routes/stream/server.test.ts` (tab-indented like the file):
```ts
test('GET forwards the Last-Event-ID header upstream', async () => {
	const body = new ReadableStream({
		start(controller) {
			controller.close()
		}
	})
	const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/stream', { headers: { 'Last-Event-ID': 'post-42' } })
	await GET({ request } as never)

	const init = fetchMock.mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).get('Last-Event-ID')).toBe('post-42')
})

test('GET keeps the upstream content-type on error responses', async () => {
	const fetchMock = vi.fn(
		async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } })
	)
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/stream')
	const res = await GET({ request } as never)

	expect(res.status).toBe(500)
	expect(res.headers.get('content-type')).toBe('application/json')
})
```

Run: `npm test -w web`
Expected: FAIL — no header forwarded; error response stamped `text/event-stream`.

- [ ] **Step 2: Implement**

Replace `web/src/routes/stream/+server.ts` entirely:
```ts
import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

export const GET: RequestHandler = async ({ request }) => {
	// EventSource sends Last-Event-ID on reconnect; forwarding it lets core
	// replay missed posts through this proxy.
	const lastEventId = request.headers.get('last-event-id')
	const upstream = await fetch(`${base()}/timeline/stream`, {
		signal: request.signal,
		headers: lastEventId ? { 'Last-Event-ID': lastEventId } : {}
	})
	if (!upstream.ok) {
		return new Response(upstream.body, {
			status: upstream.status,
			headers: { 'content-type': upstream.headers.get('content-type') ?? 'text/plain' }
		})
	}
	return new Response(upstream.body, {
		status: upstream.status,
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache'
		}
	})
}
```
(The old `NOTE:` breadcrumb comment about #20 is gone — the forwarding now exists. The existing first test asserts `toHaveBeenCalledWith(url, expect.objectContaining({ signal }))` — `objectContaining` tolerates the added `headers` key, so it stays green.)

- [ ] **Step 3: Run — verify it passes**

Run: `npm test -w web`
Expected: PASS (existing 2 stream tests + 2 new).

- [ ] **Step 4: Check + commit**

Run: `npm run check -w web`
Expected: 0 errors.

```bash
git add web/src/routes/stream/+server.ts web/src/routes/stream/server.test.ts
git commit -m "$(printf 'web: stream proxy forwards Last-Event-ID; honest error content-type\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 8: Web pagination end to end — API client + page (merged per plan-review D1)

This task deliberately spans the API client and the page that consumes it, so
the commit lands with every web gate green (the client's return-shape change
breaks the load tests mid-task; they are fixed within this same task, never
committed red).

**Files:**
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/lib/api.test.ts`
- Modify: `web/src/routes/+page.server.ts` (load; actions untouched)
- Modify: `web/src/routes/+page.svelte`
- Modify: `web/src/routes/page.load.test.ts`

**Interfaces:**
- Consumes: core's `{ timeline, nextCursor }` response (Task 4) and error bodies `{ error: string }`.
- Produces:
  - `interface TimelinePage { timeline: TimelineEntry[]; nextCursor: string | null }`
  - `getTimeline(f: typeof fetch, before?: string): Promise<TimelinePage>` — `before` is the OPAQUE wire cursor string; the client never parses it.
  - `createPost` / `addRemoteUser` unchanged signatures, but thrown errors carry core's `error` message when present.
  - `load` returns `{ timeline, nextCursor: string | null, isFirstPage: boolean, coreDown?: true }`; the live island mounts only when `isFirstPage`.

- [ ] **Step 1: Failing api-client tests — replace `web/src/lib/api.test.ts` entirely**

```ts
import { test, expect, vi } from 'vitest'
import { getTimeline, createPost, addRemoteUser } from './api.ts'

const entry = {
	id: 'p1',
	title: null,
	content: 'hi',
	url: null,
	publishedAt: '',
	source: 'local',
	author: { handle: 'a', displayName: 'A', kind: 'local' }
}

test('getTimeline returns entries and the next cursor', async () => {
	const f = vi.fn(
		async () => new Response(JSON.stringify({ timeline: [entry], nextCursor: '2026~p1' }), { status: 200 })
	)
	const page = await getTimeline(f as unknown as typeof fetch)
	expect(page.timeline[0].content).toBe('hi')
	expect(page.nextCursor).toBe('2026~p1')
	expect(f).toHaveBeenCalledWith('http://localhost:8787/timeline')
})

test('getTimeline passes the before cursor as a query param and defaults nextCursor to null', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ timeline: [] }), { status: 200 }))
	const page = await getTimeline(f as unknown as typeof fetch, '2026-01-01T00:00:00.000Z~p9')
	expect(f).toHaveBeenCalledWith('http://localhost:8787/timeline?before=2026-01-01T00%3A00%3A00.000Z~p9')
	expect(page.nextCursor).toBeNull()
})

test('createPost sends the bearer token', async () => {
	const f = vi.fn(async () => new Response(null, { status: 201 }))
	await createPost(f as unknown as typeof fetch, { handle: 'a', displayName: 'A', content: 'x' })
	const init = f.mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).get('authorization')).toMatch(/^Bearer /)
})

test('addRemoteUser sends the bearer token', async () => {
	const f = vi.fn(async () => new Response(null, { status: 201 }))
	await addRemoteUser(f as unknown as typeof fetch, { handle: 'a', displayName: 'A', feedUrl: 'https://x/f' })
	const init = f.mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).get('authorization')).toMatch(/^Bearer /)
})

test('createPost surfaces the core error message', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid handle' }), { status: 400 }))
	await expect(createPost(f as unknown as typeof fetch, { handle: '!', displayName: '!', content: 'x' })).rejects.toThrow(
		'invalid handle'
	)
})

test('addRemoteUser falls back to a status message when the body has no error field', async () => {
	const f = vi.fn(async () => new Response('nope', { status: 502 }))
	await expect(
		addRemoteUser(f as unknown as typeof fetch, { handle: 'a', displayName: 'A', feedUrl: 'https://x/f' })
	).rejects.toThrow('addRemoteUser 502')
})
```

Run: `npm test -w web`
Expected: FAIL — `getTimeline` returns an array (no `.timeline`), errors say `createPost 400`.

- [ ] **Step 2: Implement the api client — replace `web/src/lib/api.ts` entirely**

```ts
import { env } from '$env/dynamic/private'
import type { TimelineEntry } from './types.ts'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'
const token = () => env.CORE_API_TOKEN ?? ''

export interface TimelinePage {
	timeline: TimelineEntry[]
	nextCursor: string | null
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
	try {
		const body = (await res.json()) as { error?: unknown }
		if (typeof body.error === 'string') return body.error
	} catch {
		// non-JSON body — use the fallback
	}
	return fallback
}

export async function getTimeline(f: typeof fetch, before?: string): Promise<TimelinePage> {
	const url = new URL(`${base()}/timeline`)
	if (before) url.searchParams.set('before', before)
	const res = await f(url.toString())
	if (!res.ok) throw new Error(await errorMessage(res, `timeline ${res.status}`))
	const body = (await res.json()) as { timeline: TimelineEntry[]; nextCursor?: string | null }
	return { timeline: body.timeline, nextCursor: body.nextCursor ?? null }
}

export async function createPost(
	f: typeof fetch,
	input: { handle: string; displayName: string; content: string }
): Promise<void> {
	const res = await f(`${base()}/posts`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
		body: JSON.stringify(input)
	})
	if (!res.ok) throw new Error(await errorMessage(res, `createPost ${res.status}`))
}

export async function addRemoteUser(
	f: typeof fetch,
	input: { handle: string; displayName: string; feedUrl: string }
): Promise<void> {
	const res = await f(`${base()}/users`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
		body: JSON.stringify(input)
	})
	if (!res.ok) throw new Error(await errorMessage(res, `addRemoteUser ${res.status}`))
}
```

Run: `npm test -w web`
Expected: the 6 api tests PASS; `page.load.test.ts` now FAILS (`result.timeline` is undefined — `load` still treats `getTimeline` as returning an array). That is this task's mid-point, NOT a commit point — continue.

- [ ] **Step 3: Update the load tests — replace `web/src/routes/page.load.test.ts` entirely**

```ts
import { test, expect, vi } from 'vitest'
import { load } from './+page.server.ts'
import type { TimelineEntry } from '$lib/types'

const entry = (id: string, content: string) => ({
	id,
	title: null,
	content,
	url: null,
	publishedAt: '',
	source: 'local',
	author: { handle: 'a', displayName: 'A', kind: 'local' }
})

test('load returns the first timeline page with isFirstPage and nextCursor', async () => {
	const fetch = vi.fn(
		async () => new Response(JSON.stringify({ timeline: [entry('p1', 'hello')], nextCursor: 'ts~p1' }), { status: 200 })
	)
	const result = (await load({ fetch, url: new URL('http://x/') } as never)) as {
		timeline: TimelineEntry[]
		nextCursor: string | null
		isFirstPage: boolean
	}
	expect(result.timeline[0].content).toBe('hello')
	expect(result.nextCursor).toBe('ts~p1')
	expect(result.isFirstPage).toBe(true)
})

test('load passes ?before= through to the core call and clears isFirstPage', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 }))
	const result = (await load({ fetch, url: new URL('http://x/?before=ts~p9') } as never)) as {
		isFirstPage: boolean
		nextCursor: string | null
	}
	expect(String(fetch.mock.calls[0][0])).toContain('before=ts~p9')
	expect(result.isFirstPage).toBe(false)
	expect(result.nextCursor).toBeNull()
})

test('load returns an empty timeline with coreDown when the core is unreachable', async () => {
	const fetch = vi.fn(async () => {
		throw new Error('fetch failed')
	})
	const result = await load({ fetch, url: new URL('http://x/') } as never)
	expect(result).toEqual({ timeline: [], nextCursor: null, isFirstPage: true, coreDown: true })
})
```

Run: `npm test -w web`
Expected: load tests still FAIL (`load` neither reads `url` nor returns the new keys) — the RED for the next step.

- [ ] **Step 4: Implement the load change**

In `web/src/routes/+page.server.ts`, replace the `load` export (actions stay untouched):
```ts
export const load: PageServerLoad = async ({ fetch, url }) => {
	const before = url.searchParams.get('before') ?? undefined
	const isFirstPage = !before
	try {
		const { timeline, nextCursor } = await getTimeline(fetch, before)
		return { timeline, nextCursor, isFirstPage }
	} catch {
		return { timeline: [], nextCursor: null, isFirstPage, coreDown: true }
	}
}
```

- [ ] **Step 5: Wire the page**

In `web/src/routes/+page.svelte`:

1. Gate the island (line 16) — replace `<LiveTimeline {onPost} />` with:
```svelte
{#if data.isFirstPage}
	<LiveTimeline {onPost} />
{/if}
```
2. Append after the closing `</ul>`:
```svelte
{#if data.nextCursor}
	<a class="older" href="/?before={encodeURIComponent(data.nextCursor)}">Older posts</a>
{/if}
```
(R2 note, deliberately NOT addressed with code: live frames may interleave with replayed frames in the island's prepend order until a refresh — that is the island's existing semantic; do not add client-side sorting.)

- [ ] **Step 6: Run — verify everything passes**

Run: `npm test -w web`
Expected: PASS — all web tests (api + load + actions + stream).

Run: `npm run check -w web && npm run build -w web`
Expected: 0 errors; build succeeds.

- [ ] **Step 7: Commit (single commit, all green)**

```bash
git add web/src/lib/api.ts web/src/lib/api.test.ts web/src/routes/+page.server.ts web/src/routes/+page.svelte web/src/routes/page.load.test.ts
git commit -m "$(printf 'web: cursor pagination end to end (TimelinePage, ?before=, Older-posts link, island gating)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 9: TypeScript alignment + whole-batch verification

**Files:**
- Modify: `core/package.json` (typescript devDependency) — or `web/package.json` if the fallback path is taken
- Modify: `package-lock.json` (via npm)

**Interfaces:**
- Consumes: everything. Produces: one TypeScript major across the workspace, and the full green gate set.

- [ ] **Step 1: Try moving core to TypeScript 6**

```bash
npm install -D typescript@^6 -w core
npm run typecheck -w core
```
Expected: exit 0. If it fails with real type errors: revert (`npm install -D typescript@^5.6.0 -w core`) and instead pin web down: edit `web/package.json` `"typescript"` to `"^5.9.0"`, run `npm install`, then `npm run check -w web` must pass. Either endpoint is acceptable; the requirement is ONE major on both sides.

- [ ] **Step 2: Full gates (all five, capture output)**

```bash
npm test -w core
npm test -w web
npm run typecheck -w core
npm run check -w web
npm run build -w web
```
Expected: core suite green (existing + this batch's additions), web suite green, typecheck exit 0, check 0 errors, build success.

- [ ] **Step 3: Manual end-to-end smoke — replay, cursor, and the web pagination UI (plan-review D3)**

```bash
TEXTCASTER_DB=:memory: TEXTCASTER_TOKEN=dev TEXTCASTER_POLL_SECONDS=60 npm run dev -w core &
sleep 2
# 103 posts total: "first", then post 1..101, then "tip" — page 1 fills at 100.
curl -s -XPOST localhost:8787/posts -H 'authorization: Bearer dev' -H 'content-type: application/json' -d '{"handle":"a","displayName":"A","content":"first"}' >/dev/null
for i in $(seq 1 101); do curl -s -XPOST localhost:8787/posts -H 'authorization: Bearer dev' -H 'content-type: application/json' -d "{\"handle\":\"a\",\"displayName\":\"A\",\"content\":\"post $i\"}" >/dev/null; done
TIP_ID=$(curl -s -XPOST localhost:8787/posts -H 'authorization: Bearer dev' -H 'content-type: application/json' -d '{"handle":"a","displayName":"A","content":"tip"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["post"]["id"])')

# Replay smoke: one post "missed" after the tip anchor.
curl -s -XPOST localhost:8787/posts -H 'authorization: Bearer dev' -H 'content-type: application/json' -d '{"handle":"a","displayName":"A","content":"missed while away"}' >/dev/null
curl -s -N -m 3 -H "Last-Event-ID: $TIP_ID" localhost:8787/timeline/stream | head -8
# Expected frames include BOTH "tip" (inclusive re-delivery) and "missed while away".

# Cursor smoke over HTTP:
CUR=$(curl -s 'localhost:8787/timeline?limit=1' | python3 -c 'import json,sys; print(json.load(sys.stdin)["nextCursor"])')
curl -s "localhost:8787/timeline?before=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$CUR'))")&limit=1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["timeline"][0]["content"])'
# Expected: the next-older post's content ("missed while away" is newest, so this prints "tip").

# Web pagination UI smoke (D3 — the two assertions unit tests can't reach):
npm run dev -w web &
sleep 3
curl -s http://localhost:5173/ | grep -o 'Older posts' | head -1
# Expected: "Older posts" (page 1 is full → link renders).
HREF=$(curl -s http://localhost:5173/ | grep -o '/?before=[^"]*' | head -1)
curl -s "http://localhost:5173$HREF" | grep -c 'Older posts'
# Expected: 0 (page 2 is short → no link; also demonstrates island gating input isFirstPage=false in the embedded data).
curl -s "http://localhost:5173$HREF" | grep -o '>first<' | head -1
# Expected: ">first<" (the oldest post renders on page 2 with no JavaScript).
kill %1 %2
```

- [ ] **Step 4: Commit**

```bash
git add core/package.json web/package.json package-lock.json
git commit -m "$(printf 'chore: one TypeScript major across the workspace; debt batch complete\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Self-Review (done at plan-writing time; plan-review M1/D1/M2/D2/D3/D4 applied)

- **Spec coverage:** migrations + fail-fast + RUNNING.md → Task 1; cursor/replay repo primitives + contract pins (incl. H1/R1 regression pins) → Task 2; dup-handle contract + H7/H8 guard surgery → Task 3; `?before=`/`nextCursor` API → Task 4; SSE replay (subscribe-first H2, inclusive R1, cap-skip H4, unknown-id, backfill-accepted H3 needs no code) → Task 5; config guards + displayName + `'\0'` separator (H9 noted) + sniff-only/BOM + backfill pin → Task 6; proxy Last-Event-ID + error content-type (H10b) → Task 7; TimelinePage + error surfacing (H10a) + auth-header pins + `isFirstPage`/Older-posts/island gating + R2 accepted → Task 8 (merged); TS alignment + gates + replay/cursor/web-UI smoke → Task 9. Non-goals built nowhere.
- **Placeholder scan:** every code step carries complete code; the only prose-directed edits are RUNNING.md (Task 1, exact replacement text given) and the two-line displayName insertion (Task 6, exact line given).
- **Type consistency:** `TimelineCursor {publishedAt,id}` defined once (Task 2), consumed by repo (2), service passthrough (4), cursor codec (4); `getTimelineAfter(sinceCreatedAt: string, limit: number)` identical in repo (2), service (5), route (5); `HandleTakenError extends DomainError` (3) relied on by service catch (3) and existing onError mapping; `TimelinePage {timeline,nextCursor}` and `isFirstPage` produced and consumed inside Task 8. Web wire cursor stays an opaque `string` end to end — only core parses it.
- **Gate discipline:** every task's commit lands with its workspace's gates green; the one deliberate mid-task red (Task 8 between Steps 2 and 6) never reaches a commit.
