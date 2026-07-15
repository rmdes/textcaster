# Textcaster Push-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remote feeds that advertise push get pushed to us — WebSub subscriber (discovery, subscription, signature-verified fat pings, lease renewal) and rssCloud receiving (registration, thin pings, daily re-register) — with polling demoted to a 10×-slower correctness backstop.

**Architecture:** One new outbound-state table (`push_subscriptions`, migration 3) behind the Repository contract; one new domain module (`push-in.ts`) holding discovery-decision, the subscribe/renewal engine, and all four callback handlers; the existing poller loop becomes the scheduler (polls, discovery, renewals — no new timers). `ingest.ts` gets its one refactor: a single parse yields items + discovery metadata, and the insert loop is extracted for fat pings to reuse.

**Tech Stack:** Existing only — feedsmith (parsed metadata probed: `parsed.format` discriminator; RSS `feed.atom.links`/`feed.cloud`, Atom `feed.links`, JSON `feed.hubs`/`feed.feed_url`), Hono, Kysely/better-sqlite3, node:crypto. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-15-textcaster-push-in-design.md` (rev 3, binding). Review context: `docs/superpowers/reviews/2026-07-15-push-in-spec-review.md`.

## Global Constraints

- TypeScript/ESM; no new dependencies; no Kysely/SQLite outside `core/src/storage/`; contract suite adapter-neutral; web/ untouched.
- `TEXTCASTER_PUSH_IN=on` default, `off` kill-switch, other values fail fast; effective only when `publicUrl` set — NO fail-fast without it, just a one-line startup notice and dormancy.
- Discovered hub/cloud endpoints are attacker-controlled: `checkCallbackUrl` gate + `redirect: 'manual'` on every hub/cloud request. Feed fetches keep following redirects.
- H4/R1 token stability: `callback_token` + `secret` generated ONCE per `(user, mode)`; the upsert NEVER overwrites them; on retry/renewal the hub POST is built from the STORED row's token/secret, never a fresh one.
- H3: `pending` rows expire in 10 minutes; every "existing subscription?" gate reads UNEXPIRED pending/active.
- H1: accept ALL FOUR `X-Hub-Signature` algorithms (`sha1`, `sha256`, `sha384`, `sha512`) — the hub picks; real hubs sign sha1.
- H2: missing/invalid signature → **202, discard, log** — never a 4xx (no hub-drop invitation, no signature oracle).
- H5: thin-ping re-fetches floor at 30 seconds per topic (in-memory map).
- Verification GET handling is state-agnostic (renewal re-verifications arrive while `active`).
- Thin pings NEVER fetch attacker-supplied URLs — the `url` param is only a lookup key; we re-fetch our stored `feedUrl`.
- One parse per poll body: `parseFeedWithMeta` yields items + discovery; `ingestRemoteUser` merges `Link`-header discovery (W3C-required, not a fallback) into its returned metadata.
- TDD; failing test first. Commit after each task; end every commit message with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Scoped `git add` of named files only — never `-A` (a parallel session commits web/ work to this shared checkout).

## File structure

```
core/src/config.ts                 # + pushIn (Task 1)
core/src/domain/types.ts           # + PushSubscription (Task 2)
core/src/domain/repository.ts      # + 4 push-subscription methods (Task 2)
core/src/storage/sqlite.ts         # + migration 3, queries (Task 2)
core/src/domain/repository-contract.ts  # + pins (Task 2)
core/src/domain/ingest.ts          # parseFeedWithMeta + ingestItems split (Task 3)
core/src/domain/push-in.ts         # NEW: decision, engine, callback handlers (Tasks 4-7)
core/src/api/app.ts                # + 4 callback routes behind pushInApi (Task 6-7)
core/src/server.ts                 # poll cycle rewrite + wiring (Task 5)
core/test/push-in.test.ts          # NEW (Tasks 4-7)
core/test/federation-live.test.ts  # NEW (Task 8)
docs/superpowers/documentation/RUNNING.md  # push-in section (Task 8)
```

---

### Task 1: Config — `TEXTCASTER_PUSH_IN`

**Files:**
- Modify: `core/src/config.ts`
- Modify: `core/test/config.test.ts`

**Interfaces:**
- Produces: `Config` gains `pushIn: boolean` (default true). No publicUrl fail-fast interaction (dormancy is runtime behavior, Task 5).

- [ ] **Step 1: Failing tests** — append to `core/test/config.test.ts`:
```ts
test('pushIn defaults on, accepts off, rejects garbage', () => {
  expect(loadConfig({ TEXTCASTER_TOKEN: 't' }).pushIn).toBe(true)
  expect(loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_PUSH_IN: 'off' }).pushIn).toBe(false)
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_PUSH_IN: 'maybe' })).toThrow('TEXTCASTER_PUSH_IN')
})
test('pushIn on without publicUrl is NOT a startup error (dormant, not fatal)', () => {
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_PUSH_IN: 'on' })).not.toThrow()
})
```

- [ ] **Step 2: RED** — Run: `npm test -w core`; expected: `pushIn` undefined / no throw on garbage.

- [ ] **Step 3: Implement** — in `core/src/config.ts`: add `pushIn: boolean` to the `Config` interface (after `rssCloud`), and in `loadConfig` after the rssCloud block:
```ts
  const rawPushIn = env.TEXTCASTER_PUSH_IN ?? 'on'
  if (rawPushIn !== 'on' && rawPushIn !== 'off') throw new Error(`TEXTCASTER_PUSH_IN must be "on" or "off", got "${rawPushIn}"`)
  const pushIn = rawPushIn === 'on'
```
Add `pushIn,` to the returned object. IMPORTANT: do NOT add `pushIn` to the existing publicUrl fail-fast condition — push-in without publicUrl is dormant, not fatal (spec §2).

- [ ] **Step 4: GREEN** — `npm test -w core` all pass; `npm run typecheck -w core` exit 0.

- [ ] **Step 5: Commit**
```bash
git add core/src/config.ts core/test/config.test.ts
git commit -m "$(printf 'core: TEXTCASTER_PUSH_IN kill-switch (default on, dormant without public URL)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 2: Migration 3 — `push_subscriptions` + contract pins + 2→3 upgrade test

**Files:**
- Modify: `core/src/domain/types.ts`, `core/src/domain/repository.ts`, `core/src/storage/sqlite.ts`, `core/src/domain/repository-contract.ts`, `core/test/migrations.test.ts`

**Interfaces:**
- Produces (exact shapes later tasks rely on):
  - `interface PushSubscription { id: string; userId: string; mode: PushProtocol; endpoint: string; topic: string; callbackToken: string; secret: string | null; state: 'pending' | 'active'; expiresAt: string; createdAt: string }`
  - `upsertPushSubscription(s): Promise<void>` — conflict on `(user_id, mode)`, DO UPDATE `endpoint, topic, state, expires_at` — **NOT callback_token or secret (H4)**.
  - `findPushSubscription(filter: { token?: string; userId?: string; mode?: PushProtocol; topic?: string }, opts?: { unexpiredAt?: string; state?: 'pending' | 'active' }): Promise<PushSubscription | undefined>`
  - `listRenewablePushSubscriptions(before: string): Promise<PushSubscription[]>` — `state = 'active' AND expires_at < before`.
  - `deletePushSubscription(id: string): Promise<void>`

- [ ] **Step 1: Failing contract tests** — append inside the describe block in `core/src/domain/repository-contract.ts` (extend the type import with `PushSubscription`):
```ts
    function pushSub(over: Partial<PushSubscription>, userId: string): PushSubscription {
      return { id: crypto.randomUUID(), userId, mode: 'websub', endpoint: 'https://hub.example.com/hub', topic: 'https://blog.example.com/feed.xml', callbackToken: 'tok-' + crypto.randomUUID(), secret: 's3cret', state: 'pending', expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', ...over }
    }

    test('upsertPushSubscription keys on (user, mode) and NEVER overwrites token or secret', async () => {
      const repo = await makeRepo()
      const u = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://blog.example.com/feed.xml' })
      await repo.upsertPushSubscription(pushSub({ callbackToken: 'original-token', secret: 'original-secret' }, u.id))
      await repo.upsertPushSubscription(pushSub({ callbackToken: 'SHOULD-NOT-LAND', secret: 'SHOULD-NOT-LAND', state: 'active', expiresAt: '2028-01-01T00:00:00.000Z', endpoint: 'https://hub2.example.com/hub' }, u.id))
      const row = await repo.findPushSubscription({ userId: u.id, mode: 'websub' })
      expect(row?.callbackToken).toBe('original-token') // H4 pin
      expect(row?.secret).toBe('original-secret')
      expect(row?.state).toBe('active')
      expect(row?.endpoint).toBe('https://hub2.example.com/hub')
    })

    test('findPushSubscription filters by token, user+mode, mode+topic, expiry, and state', async () => {
      const repo = await makeRepo()
      const u = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://blog.example.com/feed.xml' })
      await repo.upsertPushSubscription(pushSub({ callbackToken: 'tok-1', state: 'active', expiresAt: '2027-01-01T00:00:00.000Z' }, u.id))
      await repo.upsertPushSubscription(pushSub({ mode: 'rsscloud', callbackToken: 'tok-2', topic: 'https://blog.example.com/rss.xml', state: 'pending', expiresAt: '2026-01-01T00:10:00.000Z' }, u.id))
      expect((await repo.findPushSubscription({ token: 'tok-1' }))?.mode).toBe('websub')
      expect((await repo.findPushSubscription({ userId: u.id, mode: 'rsscloud' }))?.callbackToken).toBe('tok-2')
      expect((await repo.findPushSubscription({ mode: 'rsscloud', topic: 'https://blog.example.com/rss.xml' }))?.userId).toBe(u.id)
      expect(await repo.findPushSubscription({ userId: u.id }, { unexpiredAt: '2026-06-01T00:00:00.000Z' })).toMatchObject({ mode: 'websub' }) // pending one expired
      expect(await repo.findPushSubscription({ userId: u.id }, { state: 'pending' })).toMatchObject({ mode: 'rsscloud' })
      expect(await repo.findPushSubscription({ token: 'nope' })).toBeUndefined()
    })

    test('listRenewablePushSubscriptions returns only active rows expiring before the horizon', async () => {
      const repo = await makeRepo()
      const u = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://blog.example.com/feed.xml' })
      await repo.upsertPushSubscription(pushSub({ state: 'active', expiresAt: '2026-06-01T00:00:00.000Z' }, u.id))
      await repo.upsertPushSubscription(pushSub({ mode: 'rsscloud', callbackToken: 'tok-rc', state: 'pending', expiresAt: '2026-06-01T00:00:00.000Z' }, u.id))
      const due = await repo.listRenewablePushSubscriptions('2026-07-01T00:00:00.000Z')
      expect(due.length).toBe(1)
      expect(due[0].mode).toBe('websub')
      expect((await repo.listRenewablePushSubscriptions('2026-05-01T00:00:00.000Z')).length).toBe(0)
    })

    test('deletePushSubscription removes the row', async () => {
      const repo = await makeRepo()
      const u = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://blog.example.com/feed.xml' })
      const s = pushSub({}, u.id)
      await repo.upsertPushSubscription(s)
      const row = await repo.findPushSubscription({ userId: u.id, mode: 'websub' })
      await repo.deletePushSubscription(row!.id)
      expect(await repo.findPushSubscription({ userId: u.id, mode: 'websub' })).toBeUndefined()
    })
```

- [ ] **Step 2: Update migration tests** — in `core/test/migrations.test.ts`: change the fresh-DB expectation to `.toBe(3)`. Append a frozen V2 additions constant + upgrade test:
```ts
const V2_ADDITIONS = [
  `CREATE TABLE subscriptions (
      id text PRIMARY KEY,
      protocol text NOT NULL,
      topic text NOT NULL,
      callback text NOT NULL,
      callback_host text NOT NULL,
      secret text,
      expires_at text NOT NULL,
      created_at text NOT NULL,
      CONSTRAINT subscriptions_triple_uq UNIQUE (protocol, topic, callback)
    )`,
  'CREATE INDEX subscriptions_topic_idx ON subscriptions (topic, expires_at)',
  'CREATE INDEX subscriptions_host_idx ON subscriptions (callback_host, expires_at)',
]

test('a version-2 database upgrades in place to version 3 with data preserved', async () => {
  const file = tempDb()
  const raw = new Database(file)
  for (const stmt of [...V1_SCHEMA, ...V2_ADDITIONS]) raw.exec(stmt)
  raw.prepare("INSERT INTO users VALUES ('u1','remote','blog','Blog','https://blog.example.com/feed.xml','2026-01-01T00:00:00.000Z')").run()
  raw.prepare("INSERT INTO subscriptions VALUES ('s1','websub','t','c','h',NULL,'2027-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run()
  raw.pragma('user_version = 2')
  raw.close()

  const repo = await createSqliteRepository(file)
  expect((await repo.getUserByHandle('blog'))?.feedUrl).toBe('https://blog.example.com/feed.xml')
  expect(await repo.countActiveSubscriptions({ topic: 't' }, '2026-06-01T00:00:00.000Z')).toBe(1)
  await repo.upsertPushSubscription({ id: 'p1', userId: 'u1', mode: 'websub', endpoint: 'e', topic: 't2', callbackToken: 'tok', secret: null, state: 'pending', expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  const check = new Database(file, { readonly: true })
  expect(check.pragma('user_version', { simple: true })).toBe(3)
  check.close()
})
```

- [ ] **Step 3: RED** — `npm test -w core`; expected `TypeError: repo.upsertPushSubscription is not a function`, fresh-DB `3 !== 2`, upgrade test same.

- [ ] **Step 4: Implement**

`core/src/domain/types.ts` — append:
```ts
export interface PushSubscription {
  id: string
  userId: string
  mode: PushProtocol
  endpoint: string
  topic: string
  callbackToken: string
  secret: string | null
  state: 'pending' | 'active'
  expiresAt: string
  createdAt: string
}
```
`core/src/domain/repository.ts` — extend the type import with `PushSubscription`, append to the interface:
```ts
  upsertPushSubscription(s: PushSubscription): Promise<void>
  findPushSubscription(filter: { token?: string; userId?: string; mode?: PushProtocol; topic?: string }, opts?: { unexpiredAt?: string; state?: 'pending' | 'active' }): Promise<PushSubscription | undefined>
  listRenewablePushSubscriptions(before: string): Promise<PushSubscription[]>
  deletePushSubscription(id: string): Promise<void>
```
`core/src/storage/sqlite.ts`:
1. Table type + DB registration:
```ts
interface PushSubscriptionsTable { id: string; user_id: string; mode: 'websub' | 'rsscloud'; endpoint: string; topic: string; callback_token: string; secret: string | null; state: 'pending' | 'active'; expires_at: string; created_at: string }
interface DB { users: UsersTable; posts: PostsTable; subscriptions: SubscriptionsTable; push_subscriptions: PushSubscriptionsTable }
```
2. Mapper:
```ts
function rowToPushSubscription(r: PushSubscriptionsTable): PushSubscription {
  return { id: r.id, userId: r.user_id, mode: r.mode, endpoint: r.endpoint, topic: r.topic, callbackToken: r.callback_token, secret: r.secret, state: r.state, expiresAt: r.expires_at, createdAt: r.created_at }
}
```
3. Append **migration 3** to `MIGRATIONS` (new inner array after migration 2 — never edit earlier entries):
```ts
  [
    `CREATE TABLE push_subscriptions (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id),
      mode text NOT NULL,
      endpoint text NOT NULL,
      topic text NOT NULL,
      callback_token text NOT NULL UNIQUE,
      secret text,
      state text NOT NULL,
      expires_at text NOT NULL,
      created_at text NOT NULL,
      CONSTRAINT push_subscriptions_user_mode_uq UNIQUE (user_id, mode)
    )`,
    'CREATE INDEX push_subscriptions_expires_idx ON push_subscriptions (state, expires_at)',
  ],
```
4. Class methods (extend the types import with `PushSubscription`):
```ts
  async upsertPushSubscription(s: PushSubscription) {
    await this.db
      .insertInto('push_subscriptions')
      .values({ id: s.id, user_id: s.userId, mode: s.mode, endpoint: s.endpoint, topic: s.topic, callback_token: s.callbackToken, secret: s.secret, state: s.state, expires_at: s.expiresAt, created_at: s.createdAt })
      // H4: token and secret are IDENTITY across renewals — never updated on conflict.
      .onConflict((oc) => oc.columns(['user_id', 'mode']).doUpdateSet({ endpoint: s.endpoint, topic: s.topic, state: s.state, expires_at: s.expiresAt }))
      .execute()
  }
  async findPushSubscription(filter: { token?: string; userId?: string; mode?: PushProtocol; topic?: string }, opts?: { unexpiredAt?: string; state?: 'pending' | 'active' }): Promise<PushSubscription | undefined> {
    let q = this.db.selectFrom('push_subscriptions').selectAll()
    if (filter.token !== undefined) q = q.where('callback_token', '=', filter.token)
    if (filter.userId !== undefined) q = q.where('user_id', '=', filter.userId)
    if (filter.mode !== undefined) q = q.where('mode', '=', filter.mode)
    if (filter.topic !== undefined) q = q.where('topic', '=', filter.topic)
    if (opts?.unexpiredAt !== undefined) q = q.where('expires_at', '>', opts.unexpiredAt)
    if (opts?.state !== undefined) q = q.where('state', '=', opts.state)
    const r = await q.executeTakeFirst()
    return r ? rowToPushSubscription(r) : undefined
  }
  async listRenewablePushSubscriptions(before: string): Promise<PushSubscription[]> {
    const rows = await this.db.selectFrom('push_subscriptions').selectAll().where('state', '=', 'active').where('expires_at', '<', before).execute()
    return rows.map(rowToPushSubscription)
  }
  async deletePushSubscription(id: string) {
    await this.db.deleteFrom('push_subscriptions').where('id', '=', id).execute()
  }
```

- [ ] **Step 5: GREEN** — `npm test -w core` all pass; `npm run typecheck -w core` exit 0.

- [ ] **Step 6: Commit**
```bash
git add core/src/domain/types.ts core/src/domain/repository.ts core/src/storage/sqlite.ts core/src/domain/repository-contract.ts core/test/migrations.test.ts
git commit -m "$(printf 'core: migration 3 — outbound push_subscriptions with stable token identity\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 3: Ingest split — one parse yields items + discovery

**Files:**
- Modify: `core/src/domain/ingest.ts`
- Modify: `core/test/ingest.test.ts`, `core/test/federation.test.ts` (return-shape updates)

**Interfaces:**
- Produces:
  - `interface FeedDiscovery { hubs: string[]; self: string | null; cloud: { domain: string; port: number; path: string; protocol: string } | null }`
  - `parseFeedWithMeta(body: string): Promise<{ items: ParsedItem[]; discovery: FeedDiscovery }>`
  - `parseFeed(body)` unchanged signature (thin `.items` wrapper — existing tests keep passing).
  - `ingestItems(repo, bus, user, items: ParsedItem[]): Promise<number>` — the extracted insert/dedup/backfill/emit loop.
  - `parseLinkHeader(header: string | null): { hubs: string[]; self: string | null }`
  - `ingestRemoteUser(repo, bus, user, fetchFn?)` now returns `Promise<{ inserted: number; discovery: FeedDiscovery }>` — discovery MERGES Link-header (W3C-required) + body metadata (header values first, deduped).
- Consumes: existing `parseFeedDocument` (feedsmith), `parsed.format` discriminator.

- [ ] **Step 1: Failing tests** — append to `core/test/ingest.test.ts` (import `parseFeedWithMeta`, `parseLinkHeader`, `ingestItems` from the ingest module):
```ts
const RSS_WITH_PUSH = `<?xml version="1.0"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>P</title><link>https://blog.example.com</link><description>d</description><atom:link href="https://blog.example.com/feed.xml" rel="self"/><atom:link href="https://hub.example.com/hub" rel="hub"/><cloud domain="blog.example.com" port="5337" path="/rsscloud/pleaseNotify" registerProcedure="" protocol="http-post"/><item><guid>pg1</guid><title>t</title><description>b</description></item></channel></rss>`

test('parseFeedWithMeta yields items AND discovery from one parse (rss)', async () => {
  const { items, discovery } = await parseFeedWithMeta(RSS_WITH_PUSH)
  expect(items.length).toBe(1)
  expect(discovery.hubs).toEqual(['https://hub.example.com/hub'])
  expect(discovery.self).toBe('https://blog.example.com/feed.xml')
  expect(discovery.cloud).toMatchObject({ domain: 'blog.example.com', port: 5337, path: '/rsscloud/pleaseNotify', protocol: 'http-post' })
})

test('parseFeedWithMeta discovery for json and atom; rdf yields none', async () => {
  const json = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'J', feed_url: 'https://j.example.com/feed.json', hubs: [{ type: 'WebSub', url: 'https://hub.example.com/hub' }], items: [{ id: 'j1', content_text: 'x' }] })
  const j = await parseFeedWithMeta(json)
  expect(j.discovery.hubs).toEqual(['https://hub.example.com/hub'])
  expect(j.discovery.self).toBe('https://j.example.com/feed.json')
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><id>urn:a</id><link rel="self" href="https://a.example.com/atom.xml"/><link rel="hub" href="https://hub.example.com/hub"/><entry><id>a1</id><title>e</title></entry></feed>`
  const a = await parseFeedWithMeta(atom)
  expect(a.discovery.hubs).toEqual(['https://hub.example.com/hub'])
  expect(a.discovery.self).toBe('https://a.example.com/atom.xml')
})

test('parseLinkHeader extracts hub and self rels', () => {
  expect(parseLinkHeader('<https://hub.example.com/hub>; rel="hub", <https://blog.example.com/feed.xml>; rel="self"')).toEqual({ hubs: ['https://hub.example.com/hub'], self: 'https://blog.example.com/feed.xml' })
  expect(parseLinkHeader(null)).toEqual({ hubs: [], self: null })
})

test('ingestRemoteUser returns discovery merging Link headers with body metadata', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'pusher', displayName: 'P', feedUrl: 'https://blog.example.com/feed.xml' })
  const fetchFn = (async () => new Response(RSS_WITH_PUSH, { headers: { 'content-type': 'application/rss+xml', link: '<https://headerhub.example.com/h>; rel="hub"' } })) as unknown as typeof fetch
  const r = await ingestRemoteUser(repo, bus, user, fetchFn)
  expect(r.inserted).toBe(1)
  expect(r.discovery.hubs).toEqual(['https://headerhub.example.com/h', 'https://hub.example.com/hub']) // header first, deduped
  expect(r.discovery.self).toBe('https://blog.example.com/feed.xml')
})

test('ingestItems is the shared insert path (no fetch involved)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'direct', displayName: 'D', feedUrl: 'https://d.example.com/f.xml' })
  await repo.insertPost({ id: 'seed', authorId: user.id, source: 'remote', guid: 'seed-g', title: null, content: 'seed', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }) // author has posts → emits live
  const seen = vi.fn()
  bus.onNewPost(seen)
  const n = await ingestItems(repo, bus, user, [{ guid: 'fp1', title: null, content: 'pushed body', url: null, publishedAt: '2026-01-02T00:00:00.000Z' }])
  expect(n).toBe(1)
  expect(seen).toHaveBeenCalledTimes(1)
  expect(await ingestItems(repo, bus, user, [{ guid: 'fp1', title: null, content: 'pushed body', url: null, publishedAt: '2026-01-02T00:00:00.000Z' }])).toBe(0)
})
```

- [ ] **Step 2: RED** — `npm test -w core`; expected: missing exports; note the return-shape tests for `ingestRemoteUser` in EXISTING files also start failing once the signature changes in Step 3 — that is the refactor ripple this task owns.

- [ ] **Step 3: Implement** — in `core/src/domain/ingest.ts`:

1. Add after `ParsedItem`:
```ts
export interface FeedDiscovery {
  hubs: string[]
  self: string | null
  cloud: { domain: string; port: number; path: string; protocol: string } | null
}

const NO_DISCOVERY: FeedDiscovery = { hubs: [], self: null, cloud: null }
```
2. Rework the parser (rename the existing body of `parseFeed` — same per-format item mapping, plus discovery extraction; the format discriminator is `parsed.format`):
```ts
type ChannelLink = { href?: string; rel?: string }

function linksToDiscovery(links: ChannelLink[] | undefined): Pick<FeedDiscovery, 'hubs' | 'self'> {
  const hubs = (links ?? []).filter((l) => l.rel === 'hub' && l.href).map((l) => l.href as string)
  const self = (links ?? []).find((l) => l.rel === 'self' && l.href)?.href ?? null
  return { hubs, self }
}

export async function parseFeedWithMeta(body: string): Promise<{ items: ParsedItem[]; discovery: FeedDiscovery }> {
  // feedsmith's format detection chokes on a BOM, so strip it first.
  const cleanBody = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body
  const now = new Date().toISOString()
  const parsed = parseFeedDocument(cleanBody)
  if (parsed.format === 'json') {
    const items = (parsed.feed.items ?? []).map((it) =>
      toParsedItem(it.id, it.title ?? null, it.content_text ?? it.content_html ?? '', it.url ?? null, it.date_published ?? '', now))
    const hubs = (parsed.feed.hubs ?? []).map((h) => h.url).filter((u): u is string => typeof u === 'string')
    return { items, discovery: { hubs, self: parsed.feed.feed_url ?? null, cloud: null } }
  }
  if (parsed.format === 'atom') {
    const items = (parsed.feed.entries ?? []).map((it) => {
      const url = it.links?.find((l) => l.href && (!l.rel || l.rel === 'alternate'))?.href ?? null
      return toParsedItem(it.id, it.title ?? null, it.content ?? it.summary ?? '', url, it.published ?? it.updated ?? '', now)
    })
    return { items, discovery: { ...linksToDiscovery(parsed.feed.links), cloud: null } }
  }
  if (parsed.format === 'rdf') {
    const items = (parsed.feed.items ?? []).map((it) =>
      toParsedItem(undefined, it.title ?? null, it.description ?? '', it.link ?? null, it.dc?.dates?.[0] ?? '', now))
    return { items, discovery: NO_DISCOVERY }
  }
  const items = (parsed.feed.items ?? []).map((it) =>
    toParsedItem(it.guid?.value, it.title ?? null, it.description ?? it.content?.encoded ?? '', it.link ?? null, it.pubDate ?? '', now))
  const c = parsed.feed.cloud
  const cloud = c && typeof c.domain === 'string' && typeof c.path === 'string' && c.protocol === 'http-post' && typeof c.port === 'number'
    ? { domain: c.domain, port: c.port, path: c.path, protocol: c.protocol }
    : null
  return { items, discovery: { ...linksToDiscovery(parsed.feed.atom?.links), cloud } }
}

export async function parseFeed(body: string): Promise<ParsedItem[]> {
  return (await parseFeedWithMeta(body)).items
}
```
3. Link-header parser (W3C-required discovery channel):
```ts
export function parseLinkHeader(header: string | null): { hubs: string[]; self: string | null } {
  if (!header) return { hubs: [], self: null }
  const hubs: string[] = []
  let self: string | null = null
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?([^";]+)"?/.exec(part.trim())
    if (!m) continue
    const rels = m[2].split(/\s+/)
    if (rels.includes('hub')) hubs.push(m[1])
    if (rels.includes('self') && !self) self = m[1]
  }
  return { hubs, self }
}
```
4. Extract the loop + rework `ingestRemoteUser` (keep the size caps and clamp exactly as-is):
```ts
export async function ingestItems(repo: Repository, bus: EventBus, user: User, items: ParsedItem[]): Promise<number> {
  const backfill = !(await repo.hasPostsByAuthor(user.id))
  let inserted = 0
  for (const item of items) {
    const now = new Date()
    const publishedAt = new Date(item.publishedAt).getTime() > now.getTime() ? now.toISOString() : item.publishedAt
    const post: Post = { id: randomUUID(), authorId: user.id, source: 'remote', guid: item.guid, title: item.title, content: item.content, url: item.url, publishedAt, createdAt: now.toISOString() }
    if (await repo.insertPost(post)) {
      if (!backfill) bus.emitNewPost({ ...post, author: user })
      inserted++
    }
  }
  return inserted
}

export async function ingestRemoteUser(repo: Repository, bus: EventBus, user: User, fetchFn: typeof fetch = fetch): Promise<{ inserted: number; discovery: FeedDiscovery }> {
  if (!user.feedUrl) return { inserted: 0, discovery: NO_DISCOVERY }
  const res = await fetchFn(user.feedUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  const contentLength = Number(res.headers.get('content-length') ?? '0')
  if (contentLength > MAX_FEED_BYTES) throw new Error(`feed exceeds size cap: ${contentLength} bytes`)
  // ponytail: cap rejects oversized bodies but only after buffering them; stream + abort past the cap if memory ever matters
  const body = await res.text()
  if (Buffer.byteLength(body) > MAX_FEED_BYTES) throw new Error(`feed exceeds size cap: ${Buffer.byteLength(body)} bytes`)
  const { items, discovery } = await parseFeedWithMeta(body)
  const header = parseLinkHeader(res.headers.get('link'))
  const merged: FeedDiscovery = {
    hubs: [...new Set([...header.hubs, ...discovery.hubs])], // header first (W3C-required channel), deduped
    self: header.self ?? discovery.self,
    cloud: discovery.cloud,
  }
  const inserted = await ingestItems(repo, bus, user, items)
  return { inserted, discovery: merged }
}
```
5. `pollAll` unchanged in behavior (it ignores the richer return).
6. Update EXISTING call-site assertions across `core/test/ingest.test.ts` and `core/test/federation.test.ts`: every `const n = await ingestRemoteUser(...)` / `expect(n).toBe(x)` becomes `const r = await ingestRemoteUser(...)` / `expect(r.inserted).toBe(x)` (and inline forms `expect(await ingestRemoteUser(...)).toBe(0)` become `expect((await ingestRemoteUser(...)).inserted).toBe(0)`). Change assertions only — never expected values.

- [ ] **Step 4: GREEN** — `npm test -w core` all pass (same counts + 5 new); `npm run typecheck -w core` exit 0.

- [ ] **Step 5: Commit**
```bash
git add core/src/domain/ingest.ts core/test/ingest.test.ts core/test/federation.test.ts
git commit -m "$(printf 'core: one parse per poll — items + discovery metadata; ingestItems extracted\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 4: Discovery decision — `choosePushTarget`

**Files:**
- Create: `core/src/domain/push-in.ts`
- Create: `core/test/push-in.test.ts`

**Interfaces:**
- Consumes: `FeedDiscovery` (Task 3).
- Produces: `choosePushTarget(discovery: FeedDiscovery, feedUrl: string): { mode: PushProtocol; endpoint: string; topic: string } | null` — WebSub preferred (first hub); topic = `discovery.self ?? feedUrl`; rssCloud only when a `http-post` cloud is advertised, endpoint `http://<domain>:<port><path>`, topic = feedUrl (rssCloud is fetch-the-feed semantics).

- [ ] **Step 1: Failing tests** — `core/test/push-in.test.ts`:
```ts
import { test, expect, vi } from 'vitest'
import { choosePushTarget } from '../src/domain/push-in.ts'

const FEED = 'https://blog.example.com/feed.xml'

test('choosePushTarget prefers websub, topic = advertised self else feedUrl', () => {
  expect(choosePushTarget({ hubs: ['https://hub.example.com/hub'], self: 'https://blog.example.com/rss', cloud: null }, FEED))
    .toEqual({ mode: 'websub', endpoint: 'https://hub.example.com/hub', topic: 'https://blog.example.com/rss' })
  expect(choosePushTarget({ hubs: ['https://hub.example.com/hub'], self: null, cloud: null }, FEED))
    .toEqual({ mode: 'websub', endpoint: 'https://hub.example.com/hub', topic: FEED })
})

test('choosePushTarget falls back to an http-post cloud, and yields null otherwise', () => {
  const cloud = { domain: 'blog.example.com', port: 5337, path: '/rsscloud/pleaseNotify', protocol: 'http-post' }
  expect(choosePushTarget({ hubs: [], self: null, cloud }, FEED))
    .toEqual({ mode: 'rsscloud', endpoint: 'http://blog.example.com:5337/rsscloud/pleaseNotify', topic: FEED })
  expect(choosePushTarget({ hubs: ['https://hub.example.com/hub'], self: null, cloud }, FEED)?.mode).toBe('websub') // websub preferred
  expect(choosePushTarget({ hubs: [], self: null, cloud: { ...cloud, protocol: 'xml-rpc' } }, FEED)).toBeNull()
  expect(choosePushTarget({ hubs: [], self: null, cloud: null }, FEED)).toBeNull()
})
```

- [ ] **Step 2: RED** — `npm test -w core`; module missing.

- [ ] **Step 3: Implement** — `core/src/domain/push-in.ts`:
```ts
import type { FeedDiscovery } from './ingest.ts'
import type { PushProtocol } from './types.ts'

export interface PushTarget { mode: PushProtocol; endpoint: string; topic: string }

export function choosePushTarget(discovery: FeedDiscovery, feedUrl: string): PushTarget | null {
  if (discovery.hubs.length > 0) {
    return { mode: 'websub', endpoint: discovery.hubs[0], topic: discovery.self ?? feedUrl }
  }
  if (discovery.cloud && discovery.cloud.protocol === 'http-post') {
    const { domain, port, path } = discovery.cloud
    return { mode: 'rsscloud', endpoint: `http://${domain}:${port}${path}`, topic: feedUrl }
  }
  return null
}
```

- [ ] **Step 4: GREEN + typecheck**, then **Step 5: Commit**
```bash
git add core/src/domain/push-in.ts core/test/push-in.test.ts
git commit -m "$(printf 'core: push-in target selection (websub preferred, http-post cloud fallback)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 5: Subscribe/renewal engine + poll cycle + server wiring

**Files:**
- Modify: `core/src/domain/push-in.ts`, `core/src/server.ts`
- Modify: `core/test/push-in.test.ts`

**Interfaces:**
- Consumes: repo methods (Task 2), `choosePushTarget` (4), `ingestRemoteUser` rich return (3), `checkCallbackUrl`/`LookupFn` (M1 guard), `Config.pushIn` (1).
- Produces (Tasks 6-8 rely on):
  - `createPushIn(deps: { repo: Repository; config: Config; fetchFn?: typeof fetch; lookupFn?: LookupFn }): PushIn`
  - `interface PushIn { maybeSubscribe(user: User, discovery: FeedDiscovery): Promise<void>; renewDue(): Promise<void>; hasActivePush(userId: string): Promise<boolean>; /* handlers added in Tasks 6-7 */ }`
  - `pushInEffective(config: Config): boolean` — `config.pushIn && config.publicUrl !== null`.
  - Constants: `PENDING_TTL_MS = 600_000` (10 min), `WEBSUB_LEASE_SECONDS = 864000`, `WEBSUB_RENEW_HORIZON_MS = 86_400_000` (1 day), `RSSCLOUD_TTL_MS = 90_000_000` (25 h), `RSSCLOUD_RENEW_HORIZON_MS = 7_200_000` (2 h).
  - `runPollCycle(deps: { repo: Repository; bus: EventBus; config: Config; pushIn: PushIn; fetchFn?: typeof fetch }, tick: number): Promise<void>` — replaces `pollAll` in the server loop (pollAll itself stays exported for compatibility; server stops using it): every user polls unless `hasActivePush(user.id)` and `tick % 10 !== 0`; after each poll, `maybeSubscribe(user, discovery)`; then `renewDue()`; then `purgeExpiredSubscriptions`. Per-user try/catch as today.

- [ ] **Step 1: Failing tests** — append to `core/test/push-in.test.ts` (add imports: `createPushIn`, `runPollCycle`, `pushInEffective` from push-in.ts; `createSqliteRepository`, `createEventBus`, `loadConfig`; `publicLookup`-style stub):
```ts
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { loadConfig } from '../src/config.ts'
import { createPushIn, runPollCycle, pushInEffective } from '../src/domain/push-in.ts'

const PUSHIN_ENV = { TEXTCASTER_TOKEN: 't', TEXTCASTER_PUBLIC_URL: 'https://b.example.com' }
const publicLookup = async () => [{ address: '93.184.216.34' }]
const HUB_DISCOVERY = { hubs: ['https://hub.example.com/hub'], self: 'https://blog.example.com/feed.xml', cloud: null }

async function pushInSetup(env: Record<string, string> = PUSHIN_ENV) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const config = loadConfig(env)
  return { repo, bus, config }
}

test('pushInEffective requires both the switch and a public URL', () => {
  expect(pushInEffective(loadConfig(PUSHIN_ENV))).toBe(true)
  expect(pushInEffective(loadConfig({ ...PUSHIN_ENV, TEXTCASTER_PUSH_IN: 'off' }))).toBe(false)
  expect(pushInEffective(loadConfig({ TEXTCASTER_TOKEN: 't' }))).toBe(false)
})

test('maybeSubscribe creates a pending row and POSTs the hub with the STORED token', async () => {
  const { repo, config } = await pushInSetup()
  const user = await repo.createRemoteUser({ handle: 'blog', displayName: 'B', feedUrl: 'https://blog.example.com/feed.xml' })
  const calls: Array<{ url: string; body: URLSearchParams; redirect: string | undefined }> = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body)), redirect: init?.redirect as string | undefined })
    return new Response('', { status: 202 })
  })
  const pushIn = createPushIn({ repo, config, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup })
  await pushIn.maybeSubscribe(user, HUB_DISCOVERY)
  const row = await repo.findPushSubscription({ userId: user.id, mode: 'websub' })
  expect(row?.state).toBe('pending')
  expect(row?.secret).toBeTruthy()
  const call = calls[0]
  expect(call.url).toBe('https://hub.example.com/hub')
  expect(call.redirect).toBe('manual')
  expect(call.body.get('hub.mode')).toBe('subscribe')
  expect(call.body.get('hub.topic')).toBe('https://blog.example.com/feed.xml')
  expect(call.body.get('hub.callback')).toBe(`https://b.example.com/websub/callback/${row!.callbackToken}`)
  expect(call.body.get('hub.secret')).toBe(row!.secret)

  // R1: a retry (pending row expired) reuses the SAME token/secret in the hub POST
  await repo.upsertPushSubscription({ ...row!, state: 'pending', expiresAt: '2020-01-01T00:00:00.000Z' })
  await pushIn.maybeSubscribe(user, HUB_DISCOVERY)
  const again = calls[1]
  expect(again.body.get('hub.callback')).toBe(`https://b.example.com/websub/callback/${row!.callbackToken}`)
  expect(again.body.get('hub.secret')).toBe(row!.secret)
})

test('maybeSubscribe skips when a live subscription exists, when the endpoint is private, and when ineffective', async () => {
  const { repo, config } = await pushInSetup()
  const user = await repo.createRemoteUser({ handle: 'blog', displayName: 'B', feedUrl: 'https://blog.example.com/feed.xml' })
  const fetchFn = vi.fn(async () => new Response('', { status: 202 }))
  const pushIn = createPushIn({ repo, config, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup })
  await pushIn.maybeSubscribe(user, HUB_DISCOVERY)
  fetchFn.mockClear()
  await pushIn.maybeSubscribe(user, HUB_DISCOVERY) // unexpired pending row exists → skip (H3 gate)
  expect(fetchFn).not.toHaveBeenCalled()

  const user2 = await repo.createRemoteUser({ handle: 'evil', displayName: 'E', feedUrl: 'https://evil.example.com/f.xml' })
  const privateLookup = async () => [{ address: '10.0.0.5' }]
  const guarded = createPushIn({ repo, config, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: privateLookup })
  await guarded.maybeSubscribe(user2, { hubs: ['https://internal.example.com/hub'], self: null, cloud: null })
  expect(fetchFn).not.toHaveBeenCalled() // guard rejected → no request, no row
  expect(await repo.findPushSubscription({ userId: user2.id, mode: 'websub' })).toBeUndefined()

  const off = createPushIn({ repo, config: loadConfig({ ...PUSHIN_ENV, TEXTCASTER_PUSH_IN: 'off' }), fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup })
  await off.maybeSubscribe(user2, HUB_DISCOVERY)
  expect(fetchFn).not.toHaveBeenCalled()
})

test('rsscloud registration marks active on 2xx with 25h expiry', async () => {
  const { repo, config } = await pushInSetup()
  const user = await repo.createRemoteUser({ handle: 'cloudy', displayName: 'C', feedUrl: 'https://cloudy.example.com/rss.xml' })
  const calls: URLSearchParams[] = []
  const fetchFn = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => { calls.push(new URLSearchParams(String(init?.body))); return new Response('', { status: 200 }) })
  const pushIn = createPushIn({ repo, config, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup })
  await pushIn.maybeSubscribe(user, { hubs: [], self: null, cloud: { domain: 'cloudy.example.com', port: 5337, path: '/rsscloud/pleaseNotify', protocol: 'http-post' } })
  const row = await repo.findPushSubscription({ userId: user.id, mode: 'rsscloud' })
  expect(row?.state).toBe('active')
  expect(Date.parse(row!.expiresAt)).toBeGreaterThan(Date.now() + 24 * 3600 * 1000)
  expect(calls[0].get('protocol')).toBe('http-post')
  expect(calls[0].get('url1')).toBe('https://cloudy.example.com/rss.xml')
  expect(calls[0].get('path')).toBe('/rsscloud/notify')
  expect(calls[0].get('domain')).toBe('b.example.com')
})

test('renewDue re-subscribes websub near lease end and re-registers rsscloud near expiry', async () => {
  const { repo, config } = await pushInSetup()
  const u1 = await repo.createRemoteUser({ handle: 'blog', displayName: 'B', feedUrl: 'https://blog.example.com/feed.xml' })
  const u2 = await repo.createRemoteUser({ handle: 'cloudy', displayName: 'C', feedUrl: 'https://cloudy.example.com/rss.xml' })
  const soonWebsub = new Date(Date.now() + 3600 * 1000).toISOString() // 1h left — within 1-day horizon
  const soonCloud = new Date(Date.now() + 1800 * 1000).toISOString() // 30min left — within 2h horizon
  await repo.upsertPushSubscription({ id: 'w1', userId: u1.id, mode: 'websub', endpoint: 'https://hub.example.com/hub', topic: 'https://blog.example.com/feed.xml', callbackToken: 'tok-w', secret: 'sec-w', state: 'active', expiresAt: soonWebsub, createdAt: '2026-01-01T00:00:00.000Z' })
  await repo.upsertPushSubscription({ id: 'c1', userId: u2.id, mode: 'rsscloud', endpoint: 'http://cloudy.example.com:5337/rsscloud/pleaseNotify', topic: 'https://cloudy.example.com/rss.xml', callbackToken: 'tok-c', secret: null, state: 'active', expiresAt: soonCloud, createdAt: '2026-01-01T00:00:00.000Z' })
  const calls: Array<{ url: string; body: URLSearchParams }> = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), body: new URLSearchParams(String(init?.body)) }); return new Response('', { status: 202 }) })
  const pushIn = createPushIn({ repo, config, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup })
  await pushIn.renewDue()
  const websubCall = calls.find((c) => c.url === 'https://hub.example.com/hub')
  expect(websubCall?.body.get('hub.callback')).toContain('tok-w') // H4: stored token reused
  expect(calls.some((c) => c.url === 'http://cloudy.example.com:5337/rsscloud/pleaseNotify')).toBe(true)
})

test('runPollCycle slow-polls push-active feeds and discovers on polled ones', async () => {
  const { repo, bus, config } = await pushInSetup()
  const pushed = await repo.createRemoteUser({ handle: 'pushed', displayName: 'P', feedUrl: 'https://pushed.example.com/feed.xml' })
  const plain = await repo.createRemoteUser({ handle: 'plain', displayName: 'Q', feedUrl: 'https://plain.example.com/feed.xml' })
  await repo.upsertPushSubscription({ id: 'a1', userId: pushed.id, mode: 'websub', endpoint: 'https://hub.example.com/hub', topic: 'https://pushed.example.com/feed.xml', callbackToken: 'tok-a', secret: 's', state: 'active', expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  const fetched: string[] = []
  const emptyRss = '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title><link>https://x</link><description>d</description></channel></rss>'
  const fetchFn = vi.fn(async (url: string | URL | Request) => { fetched.push(String(url)); return new Response(emptyRss, { headers: { 'content-type': 'application/rss+xml' } }) })
  const pushIn = createPushIn({ repo, config, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup })
  await runPollCycle({ repo, bus, config, pushIn, fetchFn: fetchFn as unknown as typeof fetch }, 1)
  expect(fetched).toContain('https://plain.example.com/feed.xml')
  expect(fetched).not.toContain('https://pushed.example.com/feed.xml') // slow-polled away on tick 1
  fetched.length = 0
  await runPollCycle({ repo, bus, config, pushIn, fetchFn: fetchFn as unknown as typeof fetch }, 10)
  expect(fetched).toContain('https://pushed.example.com/feed.xml') // 10th tick polls everything
})
```

- [ ] **Step 2: RED** — `npm test -w core`; missing exports.

- [ ] **Step 3: Implement** — extend `core/src/domain/push-in.ts`:
```ts
import { randomBytes } from 'node:crypto'
import type { Repository } from './repository.ts'
import type { EventBus } from './bus.ts'
import type { Config } from '../config.ts'
import type { User, PushSubscription } from './types.ts'
import { checkCallbackUrl } from './push-guard.ts'
import type { LookupFn } from './push-guard.ts'
import { ingestRemoteUser } from './ingest.ts'

export const PENDING_TTL_MS = 600_000 // 10 min (spec H3)
export const WEBSUB_LEASE_SECONDS = 864000 // 10 days requested
export const WEBSUB_RENEW_HORIZON_MS = 86_400_000 // renew when < 1 day left
export const RSSCLOUD_TTL_MS = 90_000_000 // 25 h
export const RSSCLOUD_RENEW_HORIZON_MS = 7_200_000 // renew when < 2 h left
const PUSH_IN_TIMEOUT_MS = 10_000

export function pushInEffective(config: Config): boolean {
  return config.pushIn && config.publicUrl !== null
}

export interface PushIn {
  maybeSubscribe(user: User, discovery: FeedDiscovery): Promise<void>
  renewDue(): Promise<void>
  hasActivePush(userId: string): Promise<boolean>
}

export interface PushInDeps {
  repo: Repository
  config: Config
  fetchFn?: typeof fetch
  lookupFn?: LookupFn
}

export function createPushIn(deps: PushInDeps): PushIn {
  const { repo, config } = deps
  const fetchFn = deps.fetchFn ?? fetch

  // R1 (spec §4.2): the stored row's token/secret are the subscription's
  // identity — generate ONLY when no (user, mode) row exists at all.
  async function tokenAndSecret(userId: string, mode: 'websub' | 'rsscloud'): Promise<{ token: string; secret: string | null; existing: PushSubscription | undefined }> {
    const existing = await repo.findPushSubscription({ userId, mode }) // any state, even expired
    if (existing) return { token: existing.callbackToken, secret: existing.secret, existing }
    return { token: randomBytes(16).toString('hex'), secret: mode === 'websub' ? randomBytes(16).toString('hex') : null, existing: undefined }
  }

  async function sendWebSubSubscribe(sub: { userId: string; endpoint: string; topic: string; token: string; secret: string | null }): Promise<void> {
    await fetchFn(sub.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        'hub.mode': 'subscribe',
        'hub.topic': sub.topic,
        'hub.callback': `${config.publicUrl}/websub/callback/${sub.token}`,
        'hub.lease_seconds': String(WEBSUB_LEASE_SECONDS),
        'hub.secret': sub.secret ?? '',
      }).toString(),
      redirect: 'manual', // hub URL came from remote feed content
      signal: AbortSignal.timeout(PUSH_IN_TIMEOUT_MS),
    })
  }

  async function sendRssCloudRegister(sub: { endpoint: string; topic: string }): Promise<Response> {
    const pub = new URL(config.publicUrl as string)
    const port = pub.port ? Number(pub.port) : pub.protocol === 'https:' ? 443 : 80
    return fetchFn(sub.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ notifyProcedure: '', port: String(port), path: '/rsscloud/notify', protocol: 'http-post', url1: sub.topic, domain: pub.hostname }).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(PUSH_IN_TIMEOUT_MS),
    })
  }

  async function subscribe(user: User, target: PushTarget): Promise<void> {
    const gate = await checkCallbackUrl(target.endpoint, deps.lookupFn)
    if (!gate.ok) {
      console.error(`push-in: rejecting advertised ${target.mode} endpoint for ${user.handle}: ${gate.reason}`)
      return
    }
    const now = Date.now()
    const { token, secret, existing } = await tokenAndSecret(user.id, target.mode)
    if (target.mode === 'websub') {
      await repo.upsertPushSubscription({
        id: existing?.id ?? crypto.randomUUID(),
        userId: user.id, mode: 'websub', endpoint: target.endpoint, topic: target.topic,
        callbackToken: token, secret, state: 'pending',
        expiresAt: new Date(now + PENDING_TTL_MS).toISOString(), // H3: pending rows expire
        createdAt: existing?.createdAt ?? new Date(now).toISOString(),
      })
      await sendWebSubSubscribe({ userId: user.id, endpoint: target.endpoint, topic: target.topic, token, secret })
      // Row flips to active when the hub's verification GET arrives (Task 6).
    } else {
      const res = await sendRssCloudRegister({ endpoint: target.endpoint, topic: target.topic })
      if (res.ok) {
        await repo.upsertPushSubscription({
          id: existing?.id ?? crypto.randomUUID(),
          userId: user.id, mode: 'rsscloud', endpoint: target.endpoint, topic: target.topic,
          callbackToken: token, secret: null, state: 'active',
          expiresAt: new Date(now + RSSCLOUD_TTL_MS).toISOString(),
          createdAt: existing?.createdAt ?? new Date(now).toISOString(),
        })
      }
    }
  }

  return {
    async maybeSubscribe(user: User, discovery: FeedDiscovery): Promise<void> {
      try {
        if (!pushInEffective(config)) return
        const now = new Date().toISOString()
        // H3 gate: only an UNEXPIRED pending/active row blocks a new attempt.
        if (await repo.findPushSubscription({ userId: user.id }, { unexpiredAt: now })) return
        const target = choosePushTarget(discovery, user.feedUrl ?? '')
        if (!target || !user.feedUrl) return
        await subscribe(user, target)
      } catch (err) {
        console.error(`push-in subscribe failed for ${user.handle}:`, err instanceof Error ? err.message : err)
      }
    },
    async renewDue(): Promise<void> {
      try {
        if (!pushInEffective(config)) return
        const horizon = new Date(Date.now() + WEBSUB_RENEW_HORIZON_MS).toISOString()
        const due = await repo.listRenewablePushSubscriptions(horizon)
        for (const sub of due) {
          try {
            if (sub.mode === 'websub') {
              await sendWebSubSubscribe({ userId: sub.userId, endpoint: sub.endpoint, topic: sub.topic, token: sub.callbackToken, secret: sub.secret })
            } else if (Date.parse(sub.expiresAt) - Date.now() < RSSCLOUD_RENEW_HORIZON_MS) {
              const res = await sendRssCloudRegister({ endpoint: sub.endpoint, topic: sub.topic })
              if (res.ok) await repo.upsertPushSubscription({ ...sub, state: 'active', expiresAt: new Date(Date.now() + RSSCLOUD_TTL_MS).toISOString() })
            }
          } catch (err) {
            console.error(`push-in renewal failed for ${sub.topic}:`, err instanceof Error ? err.message : err)
          }
        }
      } catch (err) {
        console.error('push-in renewDue failed:', err instanceof Error ? err.message : err)
      }
    },
    async hasActivePush(userId: string): Promise<boolean> {
      return (await repo.findPushSubscription({ userId }, { unexpiredAt: new Date().toISOString(), state: 'active' })) !== undefined
    },
  }
}

export async function runPollCycle(deps: { repo: Repository; bus: EventBus; config: Config; pushIn: PushIn; fetchFn?: typeof fetch }, tick: number): Promise<void> {
  const { repo, bus, pushIn } = deps
  const fetchFn = deps.fetchFn ?? fetch
  for (const user of await repo.listRemoteUsers()) {
    try {
      // ponytail: in-memory tick cadence — a restart polls everything, the safe direction.
      if (tick % 10 !== 0 && (await pushIn.hasActivePush(user.id))) continue
      const { discovery } = await ingestRemoteUser(repo, bus, user, fetchFn)
      await pushIn.maybeSubscribe(user, discovery)
    } catch (err) {
      console.error(`ingest failed for ${user.handle}:`, err instanceof Error ? err.message : err)
    }
  }
  await pushIn.renewDue()
  await repo.purgeExpiredSubscriptions(new Date().toISOString())
}
```
(Adjust imports at the top of the file so `choosePushTarget`/`PushTarget`/`FeedDiscovery` references resolve — they live in this file and `./ingest.ts` respectively.)

- [ ] **Step 4: Wire `core/src/server.ts`** — replace the poll loop block and add the dormancy notice:
```ts
import { createPushIn, runPollCycle, pushInEffective } from './domain/push-in.ts'
```
(remove the now-unused `pollAll` import), after `const push = createPush(...)`:
```ts
const pushIn = createPushIn({ repo, config })
if (config.pushIn && !config.publicUrl) console.log('push-in inactive: no public URL')
```
and replace the loop:
```ts
let tick = 0
async function loop() {
  tick++
  try {
    await runPollCycle({ repo, bus, config, pushIn }, tick)
  } catch (err) {
    console.error('poll cycle failed:', err instanceof Error ? err.message : err)
  }
  setTimeout(loop, config.pollSeconds * 1000)
}
setTimeout(loop, config.pollSeconds * 1000)
```
(`runPollCycle` subsumes the old `pollAll` + purge calls.)

- [ ] **Step 5: GREEN** — `npm test -w core` all pass; `npm run typecheck -w core` exit 0.

- [ ] **Step 6: Commit**
```bash
git add core/src/domain/push-in.ts core/src/server.ts core/test/push-in.test.ts
git commit -m "$(printf 'core: push-in subscribe/renewal engine; poller becomes the scheduler\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 6: WebSub callback routes — verification GET + fat-ping POST

**Files:**
- Modify: `core/src/domain/push-in.ts`, `core/src/api/app.ts`, `core/src/server.ts`
- Modify: `core/test/push-in.test.ts`, `core/test/api.test.ts`

**Interfaces:**
- Produces:
  - `PushIn` gains `handleWebSubVerification(token: string, query: Record<string, string>): Promise<{ status: number; body: string }>` and `handleFatPing(token: string, body: string, signatureHeader: string | null, deps2: { bus: EventBus }): Promise<number>` (returns HTTP status; ALWAYS 202 for accepted-or-discarded per H2, 404 only for unknown token).
  - `createApp` deps gain `pushInApi?: { websubVerify: (token, query) => Promise<{status, body}>; websubDeliver: (token, body, signature) => Promise<number>; rsscloudChallenge?: ...; rsscloudPing?: ... }` (rsscloud halves in Task 7). Routes `GET|POST /websub/callback/:token`; 404 when `pushInApi` absent.
  - `verifySignature(body: string, secret: string, header: string | null): boolean` — exported for tests; accepts `sha1|sha256|sha384|sha512=<hex>` (H1), timing-safe.

- [ ] **Step 1: Failing tests** — append to `core/test/push-in.test.ts` (import `verifySignature`; `createHmac`, `timingSafeEqual` come from node:crypto in the impl, tests use createHmac):
```ts
import { createHmac } from 'node:crypto'

test('verifySignature accepts all four W3C algorithms and rejects tampering (H1)', () => {
  const body = 'the payload'
  for (const algo of ['sha1', 'sha256', 'sha384', 'sha512'] as const) {
    const sig = `${algo}=` + createHmac(algo, 'sec').update(body).digest('hex')
    expect(verifySignature(body, 'sec', sig)).toBe(true)
    expect(verifySignature(body + 'x', 'sec', sig)).toBe(false)
  }
  expect(verifySignature(body, 'sec', null)).toBe(false)
  expect(verifySignature(body, 'sec', 'md5=abc')).toBe(false)
  expect(verifySignature(body, 'sec', 'sha256=zzzz')).toBe(false)
})

test('websub verification GET is state-agnostic, flips to active with granted lease, handles denied', async () => {
  const { repo, config } = await pushInSetup()
  const u = await repo.createRemoteUser({ handle: 'blog', displayName: 'B', feedUrl: 'https://blog.example.com/feed.xml' })
  await repo.upsertPushSubscription({ id: 'v1', userId: u.id, mode: 'websub', endpoint: 'https://hub.example.com/hub', topic: 'https://blog.example.com/feed.xml', callbackToken: 'tok-v', secret: 'sec-v', state: 'pending', expiresAt: new Date(Date.now() + 600000).toISOString(), createdAt: '2026-01-01T00:00:00.000Z' })
  const pushIn = createPushIn({ repo, config, lookupFn: publicLookup })

  const ok = await pushIn.handleWebSubVerification('tok-v', { 'hub.mode': 'subscribe', 'hub.topic': 'https://blog.example.com/feed.xml', 'hub.challenge': 'chal-123', 'hub.lease_seconds': '432000' })
  expect(ok).toEqual({ status: 200, body: 'chal-123' })
  const row = await repo.findPushSubscription({ token: 'tok-v' })
  expect(row?.state).toBe('active')
  expect(Date.parse(row!.expiresAt)).toBeGreaterThan(Date.now() + 4 * 86400 * 1000)

  // re-verification while ACTIVE (renewal) still echoes — state-agnostic
  const again = await pushIn.handleWebSubVerification('tok-v', { 'hub.mode': 'subscribe', 'hub.topic': 'https://blog.example.com/feed.xml', 'hub.challenge': 'chal-456', 'hub.lease_seconds': '432000' })
  expect(again.status).toBe(200)

  expect((await pushIn.handleWebSubVerification('tok-v', { 'hub.mode': 'subscribe', 'hub.topic': 'https://WRONG.example.com/x', 'hub.challenge': 'c' })).status).toBe(404)
  expect((await pushIn.handleWebSubVerification('unknown', { 'hub.mode': 'subscribe', 'hub.topic': 'https://blog.example.com/feed.xml', 'hub.challenge': 'c' })).status).toBe(404)

  expect((await pushIn.handleWebSubVerification('tok-v', { 'hub.mode': 'denied', 'hub.topic': 'https://blog.example.com/feed.xml' })).status).toBe(200)
  expect(await repo.findPushSubscription({ token: 'tok-v' })).toBeUndefined()
})

test('fat ping with a valid signature ingests and emits; invalid → 202 discard (H2)', async () => {
  const { repo, bus, config } = await pushInSetup()
  const u = await repo.createRemoteUser({ handle: 'blog', displayName: 'B', feedUrl: 'https://blog.example.com/feed.xml' })
  await repo.insertPost({ id: 'seed2', authorId: u.id, source: 'remote', guid: 'sg', title: null, content: 'seed', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  await repo.upsertPushSubscription({ id: 'f1', userId: u.id, mode: 'websub', endpoint: 'https://hub.example.com/hub', topic: 'https://blog.example.com/feed.xml', callbackToken: 'tok-f', secret: 'sec-f', state: 'active', expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: '2026-01-01T00:00:00.000Z' })
  const pushIn = createPushIn({ repo, config, lookupFn: publicLookup })
  const seen = vi.fn()
  bus.onNewPost(seen)
  const feedBody = '<?xml version="1.0"?><rss version="2.0"><channel><title>P</title><link>https://blog.example.com</link><description>d</description><item><guid>fat-1</guid><description>pushed content</description></item></channel></rss>'
  const goodSig = 'sha1=' + createHmac('sha1', 'sec-f').update(feedBody).digest('hex')

  expect(await pushIn.handleFatPing('tok-f', feedBody, goodSig, { bus })).toBe(202)
  expect(seen).toHaveBeenCalledTimes(1)
  expect((await repo.getTimeline(10)).map((e) => e.guid)).toContain('fat-1')

  const tampered = feedBody.replace('pushed content', 'evil content')
  expect(await pushIn.handleFatPing('tok-f', tampered, goodSig, { bus })).toBe(202) // H2: silent discard, not 4xx
  expect((await repo.getTimeline(10)).some((e) => e.content === 'evil content')).toBe(false)
  expect(await pushIn.handleFatPing('tok-f', feedBody, null, { bus })).toBe(202) // missing sig: same
  expect(await pushIn.handleFatPing('unknown-token', feedBody, goodSig, { bus })).toBe(404)
})
```
Append to `core/test/api.test.ts`:
```ts
test('websub callback routes are 404 when pushInApi is not wired', async () => {
  const app = await makeApp()
  expect((await app.request('/websub/callback/some-token?hub.mode=subscribe')).status).toBe(404)
  expect((await app.request('/websub/callback/some-token', { method: 'POST', body: 'x' })).status).toBe(404)
})
```

- [ ] **Step 2: RED** — `npm test -w core`; missing exports/methods; the api-route test passes already only if the route truly 404s by absence — after Step 3 wiring it must 404 by the `pushInApi` guard (assert stays green).

- [ ] **Step 3: Implement**

`core/src/domain/push-in.ts` — add:
```ts
import { createHmac, timingSafeEqual } from 'node:crypto'
import { parseFeedWithMeta, ingestItems } from './ingest.ts'
const MAX_FAT_PING_BYTES = 5 * 1024 * 1024

const SIGNATURE_ALGOS = new Set(['sha1', 'sha256', 'sha384', 'sha512'])

// H1: the hub picks the algorithm. H2 handling lives at the caller.
export function verifySignature(body: string, secret: string, header: string | null): boolean {
  if (!header) return false
  const i = header.indexOf('=')
  if (i <= 0) return false
  const algo = header.slice(0, i).toLowerCase()
  const hex = header.slice(i + 1)
  if (!SIGNATURE_ALGOS.has(algo) || !/^[0-9a-f]+$/i.test(hex)) return false
  const expected = createHmac(algo, secret).update(body).digest()
  const given = Buffer.from(hex, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}
```
Extend the `PushIn` interface and returned object:
```ts
  handleWebSubVerification(token: string, query: Record<string, string>): Promise<{ status: number; body: string }>
  handleFatPing(token: string, body: string, signatureHeader: string | null, io: { bus: EventBus }): Promise<number>
```
```ts
    async handleWebSubVerification(token: string, query: Record<string, string>): Promise<{ status: number; body: string }> {
      // State-agnostic (spec rev 3): renewal re-verifications arrive while active.
      const sub = await repo.findPushSubscription({ token, mode: 'websub' })
      if (!sub || query['hub.topic'] !== sub.topic) return { status: 404, body: 'unknown subscription' }
      if (query['hub.mode'] === 'denied') {
        await repo.deletePushSubscription(sub.id)
        return { status: 200, body: 'ok' }
      }
      if (query['hub.mode'] !== 'subscribe' || !query['hub.challenge']) return { status: 404, body: 'bad verification' }
      const granted = Number(query['hub.lease_seconds'])
      const leaseSeconds = Number.isInteger(granted) && granted > 0 ? granted : WEBSUB_LEASE_SECONDS
      await repo.upsertPushSubscription({ ...sub, state: 'active', expiresAt: new Date(Date.now() + leaseSeconds * 1000).toISOString() })
      return { status: 200, body: query['hub.challenge'] }
    },
    async handleFatPing(token: string, body: string, signatureHeader: string | null, io: { bus: EventBus }): Promise<number> {
      const sub = await repo.findPushSubscription({ token, mode: 'websub' })
      if (!sub) return 404
      try {
        // H2: verification failures are silent — 202, discard, log. Never 4xx.
        if (!sub.secret || !verifySignature(body, sub.secret, signatureHeader)) {
          console.error(`fat ping discarded for ${sub.topic}: bad or missing signature`)
          return 202
        }
        const user = await repo.getUser(sub.userId)
        if (!user) return 202
        const { items } = await parseFeedWithMeta(body)
        await ingestItems(repo, io.bus, user, items)
      } catch (err) {
        console.error(`fat ping ingest failed for ${sub.topic}:`, err instanceof Error ? err.message : err)
      }
      return 202
    },
```

`core/src/api/app.ts` — add the interface + routes (next to `PushApi`):
```ts
export interface PushInApi {
  websubVerify: (token: string, query: Record<string, string>) => Promise<{ status: number; body: string }>
  websubDeliver: (token: string, body: string, signature: string | null) => Promise<number>
  rsscloudChallenge?: (url: string, challenge: string) => Promise<{ status: number; body: string }>
  rsscloudPing?: (url: string) => Promise<number>
}
```
`createApp` deps gain `pushInApi?: PushInApi`. Routes:
```ts
  app.get('/websub/callback/:token', async (c) => {
    if (!deps.pushInApi) return c.json({ error: 'not found' }, 404)
    const query: Record<string, string> = {}
    for (const [k, v] of Object.entries(c.req.query())) if (typeof v === 'string') query[k] = v
    const r = await deps.pushInApi.websubVerify(c.req.param('token') ?? '', query)
    return c.text(r.body, r.status as 200 | 404)
  })

  app.post('/websub/callback/:token', async (c) => {
    if (!deps.pushInApi) return c.json({ error: 'not found' }, 404)
    const contentLength = Number(c.req.header('content-length') ?? '0')
    if (contentLength > 5 * 1024 * 1024) return c.json({ error: 'too large' }, 413)
    const body = await c.req.text()
    if (Buffer.byteLength(body) > 5 * 1024 * 1024) return c.json({ error: 'too large' }, 413)
    const status = await deps.pushInApi.websubDeliver(c.req.param('token') ?? '', body, c.req.header('x-hub-signature') ?? null)
    return c.json({ ok: status === 202 }, status as 202 | 404)
  })
```
`core/src/server.ts` — wire it (after `const pushIn = createPushIn(...)`):
```ts
  pushInApi: pushInEffective(config)
    ? {
        websubVerify: (token: string, query: Record<string, string>) => pushIn.handleWebSubVerification(token, query),
        websubDeliver: (token: string, body: string, signature: string | null) => pushIn.handleFatPing(token, body, signature, { bus }),
      }
    : undefined,
```
(added to the existing `createApp({...})` call).

- [ ] **Step 4: GREEN** — `npm test -w core` all pass; `npm run typecheck -w core` exit 0.

- [ ] **Step 5: Commit**
```bash
git add core/src/domain/push-in.ts core/src/api/app.ts core/src/server.ts core/test/push-in.test.ts core/test/api.test.ts
git commit -m "$(printf 'core: WebSub callback — state-agnostic verification, four-algorithm fat pings\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 7: rssCloud notify routes — challenge GET + thin-ping POST

**Files:**
- Modify: `core/src/domain/push-in.ts`, `core/src/api/app.ts`, `core/src/server.ts`
- Modify: `core/test/push-in.test.ts`, `core/test/api.test.ts`

**Interfaces:**
- Produces: `PushIn` gains `handleRssCloudChallenge(url: string, challenge: string): Promise<{ status: number; body: string }>` and `handleThinPing(url: string, io: { bus: EventBus }): Promise<number>` (always 200; H5 30-second floor per topic). Routes `GET|POST /rsscloud/notify` behind `pushInApi.rsscloudChallenge/rsscloudPing`.

- [ ] **Step 1: Failing tests** — append to `core/test/push-in.test.ts`:
```ts
async function rsscloudSetup() {
  const { repo, bus, config } = await pushInSetup()
  const u = await repo.createRemoteUser({ handle: 'cloudy', displayName: 'C', feedUrl: 'https://cloudy.example.com/rss.xml' })
  await repo.upsertPushSubscription({ id: 'rc9', userId: u.id, mode: 'rsscloud', endpoint: 'http://cloudy.example.com:5337/rsscloud/pleaseNotify', topic: 'https://cloudy.example.com/rss.xml', callbackToken: 'tok-rc9', secret: null, state: 'active', expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: '2026-01-01T00:00:00.000Z' })
  return { repo, bus, config, user: u }
}

test('rsscloud challenge echoes only for known topics', async () => {
  const { repo, config } = await rsscloudSetup()
  const pushIn = createPushIn({ repo, config, lookupFn: publicLookup })
  const r = await pushIn.handleRssCloudChallenge('https://cloudy.example.com/rss.xml', 'chz-1')
  expect(r.status).toBe(200)
  expect(r.body).toContain('chz-1')
  expect((await pushIn.handleRssCloudChallenge('https://unknown.example.com/x', 'chz-2')).status).toBe(404)
})

test('thin ping re-fetches the STORED feedUrl once per 30s floor (H5)', async () => {
  const { repo, bus, config } = await rsscloudSetup()
  const rss = '<?xml version="1.0"?><rss version="2.0"><channel><title>C</title><link>https://c</link><description>d</description><item><guid>tp-1</guid><description>thin pinged</description></item></channel></rss>'
  const fetched: string[] = []
  const fetchFn = vi.fn(async (url: string | URL | Request) => { fetched.push(String(url)); return new Response(rss, { headers: { 'content-type': 'application/rss+xml' } }) })
  const pushIn = createPushIn({ repo, config, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup })

  expect(await pushIn.handleThinPing('https://cloudy.example.com/rss.xml', { bus })).toBe(200)
  await vi.waitFor(() => expect(fetched).toEqual(['https://cloudy.example.com/rss.xml'])) // stored feedUrl, not the ping url
  await vi.waitFor(async () => expect((await repo.getTimeline(10)).map((e) => e.guid)).toContain('tp-1'))

  expect(await pushIn.handleThinPing('https://cloudy.example.com/rss.xml', { bus })).toBe(200) // within 30s → coalesced
  expect(fetched.length).toBe(1)

  expect(await pushIn.handleThinPing('https://never-subscribed.example.com/x', { bus })).toBe(200) // unknown: 200 no-op, no oracle
  expect(fetched.length).toBe(1)
})
```
Append to `core/test/api.test.ts`:
```ts
test('rsscloud notify routes are 404 when pushInApi is not wired', async () => {
  const app = await makeApp()
  expect((await app.request('/rsscloud/notify?url=x&challenge=y')).status).toBe(404)
  expect((await app.request('/rsscloud/notify', { method: 'POST', body: new URLSearchParams({ url: 'x' }) })).status).toBe(404)
})
```

- [ ] **Step 2: RED** — `npm test -w core`; missing methods/routes.

- [ ] **Step 3: Implement**

`core/src/domain/push-in.ts` — inside `createPushIn` add a closure map + methods:
```ts
  // H5: in-memory floor — a ping storm costs the attacker requests and us nothing.
  const lastThinFetch = new Map<string, number>()
  const THIN_PING_FLOOR_MS = 30_000
```
```ts
    async handleRssCloudChallenge(url: string, challenge: string): Promise<{ status: number; body: string }> {
      const sub = await repo.findPushSubscription({ mode: 'rsscloud', topic: url })
      if (!sub) return { status: 404, body: 'unknown' }
      return { status: 200, body: `confirming ${challenge}` }
    },
    async handleThinPing(url: string, io: { bus: EventBus }): Promise<number> {
      try {
        const sub = await repo.findPushSubscription({ mode: 'rsscloud', topic: url }, { unexpiredAt: new Date().toISOString() })
        if (!sub) return 200 // unknown topic: 200 no-op — no subscription-list oracle
        const last = lastThinFetch.get(url) ?? 0
        if (Date.now() - last < THIN_PING_FLOOR_MS) return 200 // H5 floor
        lastThinFetch.set(url, Date.now())
        const user = await repo.getUser(sub.userId)
        if (!user) return 200
        // The ping's content is only a lookup key; we re-fetch OUR stored feedUrl.
        await ingestRemoteUser(repo, io.bus, user, fetchFn)
      } catch (err) {
        console.error(`thin ping ingest failed for ${url}:`, err instanceof Error ? err.message : err)
      }
      return 200
    },
```
(Extend the `PushIn` interface with both signatures.)

`core/src/api/app.ts` — routes:
```ts
  app.get('/rsscloud/notify', async (c) => {
    if (!deps.pushInApi?.rsscloudChallenge) return c.json({ error: 'not found' }, 404)
    const r = await deps.pushInApi.rsscloudChallenge(c.req.query('url') ?? '', c.req.query('challenge') ?? '')
    return c.text(r.body, r.status as 200 | 404)
  })

  app.post('/rsscloud/notify', async (c) => {
    if (!deps.pushInApi?.rsscloudPing) return c.json({ error: 'not found' }, 404)
    const parsed = await c.req.parseBody()
    const url = typeof parsed.url === 'string' ? parsed.url : ''
    const status = await deps.pushInApi.rsscloudPing(url)
    return c.json({ ok: true }, status as 200)
  })
```
`core/src/server.ts` — extend the `pushInApi` object:
```ts
        rsscloudChallenge: (url: string, challenge: string) => pushIn.handleRssCloudChallenge(url, challenge),
        rsscloudPing: (url: string) => pushIn.handleThinPing(url, { bus }),
```

- [ ] **Step 4: GREEN** — `npm test -w core` all pass; `npm run typecheck -w core` exit 0.

- [ ] **Step 5: Commit**
```bash
git add core/src/domain/push-in.ts core/src/api/app.ts core/src/server.ts core/test/push-in.test.ts core/test/api.test.ts
git commit -m "$(printf 'core: rssCloud receiving — challenge echo, floored thin pings\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 8: Real-time federation money tests + RUNNING.md + gates

**Files:**
- Create: `core/test/federation-live.test.ts`
- Modify: `docs/superpowers/documentation/RUNNING.md`

**Interfaces:**
- Consumes: everything. The WebSub test is the milestone's definition of done: A's M1 self-hub gets its first real subscriber — us.

- [ ] **Step 1: Write the live-loop tests**

`core/test/federation-live.test.ts`:
```ts
import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { createPush, handleWebSubRequest } from '../src/domain/push.ts'
import { createPushIn, runPollCycle } from '../src/domain/push-in.ts'
import { loadConfig } from '../src/config.ts'
import type { Hono } from 'hono'

const publicLookup = async () => [{ address: '93.184.216.34' }]

// Bridge: routes absolute URLs to the right in-process app; strips default ports.
function makeBridge(routes: Record<string, Hono>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url))
    const origin = `${u.protocol}//${u.hostname}`
    const app = routes[origin]
    if (!app) throw new Error(`bridge: no route for ${origin}`)
    return app.request(u.pathname + u.search, init)
  }) as typeof fetch
}

async function makeInstance(env: Record<string, string>) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const config = loadConfig(env)
  return { repo, bus, service, config }
}

test('REAL-TIME LOOP: B receives A post via WebSub fat ping, no polling', async () => {
  // Instance A: publisher with the M1 self-hosted hub
  const A = await makeInstance({ TEXTCASTER_TOKEN: 'a', TEXTCASTER_PUBLIC_URL: 'https://a.example', TEXTCASTER_WEBSUB: 'self' })
  // Instance B: subscriber
  const B = await makeInstance({ TEXTCASTER_TOKEN: 'b', TEXTCASTER_PUBLIC_URL: 'https://b.example' })

  const routes: Record<string, Hono> = {}
  const bridge = makeBridge(routes)

  const pushA = createPush({ repo: A.repo, config: A.config, fetchFn: bridge })
  const pushInB = createPushIn({ repo: B.repo, config: B.config, fetchFn: bridge, lookupFn: publicLookup })

  const appA = createApp({
    service: A.service, bus: A.bus, token: 'a',
    feeds: { publicUrl: 'https://a.example', hubUrl: 'https://a.example/hub', rssCloud: false },
    pushApi: { websub: (form) => handleWebSubRequest({ repo: A.repo, config: A.config, fetchFn: bridge, lookupFn: publicLookup }, form) },
  })
  const appB = createApp({
    service: B.service, bus: B.bus, token: 'b',
    pushInApi: {
      websubVerify: (token, query) => pushInB.handleWebSubVerification(token, query),
      websubDeliver: (token, body, sig) => pushInB.handleFatPing(token, body, sig, { bus: B.bus }),
    },
  })
  routes['https://a.example'] = appA
  routes['https://b.example'] = appB

  A.bus.onNewPost((e) => { void pushA.onLocalPost(e) })

  // Alice exists on A with a post; B follows her feed
  await A.service.createLocalPostAs('alice', 'Alice', 'pre-existing post')
  const aliceAtB = await B.service.addRemoteUser({ handle: 'alice-a', displayName: 'Alice (A)', feedUrl: 'https://a.example/users/alice/feed.xml' })

  // B's first poll cycle: ingests + discovers A's hub + subscribes
  await runPollCycle({ repo: B.repo, bus: B.bus, config: B.config, pushIn: pushInB, fetchFn: bridge }, 1)
  // A's hub verification is fire-and-forget; wait for B's row to flip active
  await vi.waitFor(async () => {
    const sub = await B.repo.findPushSubscription({ userId: aliceAtB.id, mode: 'websub' })
    expect(sub?.state).toBe('active')
  })

  // THE MOMENT: A posts; the fat ping crosses the bridge; B never polls again.
  const liveSeen = vi.fn()
  B.bus.onNewPost(liveSeen)
  await A.service.createLocalPostAs('alice', 'Alice', 'pushed across instances 🎯')
  await vi.waitFor(async () => {
    const contents = (await B.repo.getTimeline(10)).map((e) => e.content)
    expect(contents).toContain('pushed across instances 🎯')
  })
  expect(liveSeen).toHaveBeenCalled() // B's live timeline saw it too
})

test('tampered fat ping is silently discarded end to end (H2)', async () => {
  const B = await makeInstance({ TEXTCASTER_TOKEN: 'b', TEXTCASTER_PUBLIC_URL: 'https://b.example' })
  const pushInB = createPushIn({ repo: B.repo, config: B.config, lookupFn: publicLookup })
  const u = await B.repo.createRemoteUser({ handle: 'x', displayName: 'X', feedUrl: 'https://x.example/f.xml' })
  await B.repo.upsertPushSubscription({ id: 't1', userId: u.id, mode: 'websub', endpoint: 'https://hub.x/h', topic: 'https://x.example/f.xml', callbackToken: 'tok-t', secret: 'shh', state: 'active', expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: '2026-01-01T00:00:00.000Z' })
  const appB = createApp({ service: createService(B.repo, B.bus), bus: B.bus, token: 'b', pushInApi: { websubVerify: (t, q) => pushInB.handleWebSubVerification(t, q), websubDeliver: (t, b2, s) => pushInB.handleFatPing(t, b2, s, { bus: B.bus }) } })
  const body = '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title><link>https://x</link><description>d</description><item><guid>evil-1</guid><description>evil</description></item></channel></rss>'
  const res = await appB.request('/websub/callback/tok-t', { method: 'POST', headers: { 'x-hub-signature': 'sha256=deadbeef' }, body })
  expect(res.status).toBe(202) // never a 4xx — no oracle, no hub-drop
  expect((await B.repo.getTimeline(10)).length).toBe(0)
})

test('REAL-TIME LOOP (rssCloud): thin ping triggers immediate re-fetch', async () => {
  const A = await makeInstance({ TEXTCASTER_TOKEN: 'a', TEXTCASTER_PUBLIC_URL: 'https://a.example', TEXTCASTER_RSSCLOUD: 'on' })
  const B = await makeInstance({ TEXTCASTER_TOKEN: 'b', TEXTCASTER_PUBLIC_URL: 'https://b.example' })
  const routes: Record<string, Hono> = {}
  const bridge = makeBridge(routes)
  const { handleRssCloudRequest } = await import('../src/domain/push.ts')
  const pushA = createPush({ repo: A.repo, config: A.config, fetchFn: bridge })
  const pushInB = createPushIn({ repo: B.repo, config: B.config, fetchFn: bridge, lookupFn: publicLookup })
  routes['https://a.example'] = createApp({
    service: A.service, bus: A.bus, token: 'a',
    feeds: { publicUrl: 'https://a.example', hubUrl: null, rssCloud: true },
    pushApi: { rsscloud: (form, ip) => handleRssCloudRequest({ repo: A.repo, config: A.config, fetchFn: bridge, lookupFn: publicLookup }, form, ip) },
  })
  routes['https://b.example'] = createApp({
    service: B.service, bus: B.bus, token: 'b',
    pushInApi: {
      websubVerify: (t, q) => pushInB.handleWebSubVerification(t, q),
      websubDeliver: (t, b2, s) => pushInB.handleFatPing(t, b2, s, { bus: B.bus }),
      rsscloudChallenge: (url, ch) => pushInB.handleRssCloudChallenge(url, ch),
      rsscloudPing: (url) => pushInB.handleThinPing(url, { bus: B.bus }),
    },
  })
  A.bus.onNewPost((e) => { void pushA.onLocalPost(e) })

  await A.service.createLocalPostAs('alice', 'Alice', 'cloud seed')
  const aliceAtB = await B.service.addRemoteUser({ handle: 'alice-c', displayName: 'Alice (cloud)', feedUrl: 'https://a.example/users/alice/feed.xml' })
  await runPollCycle({ repo: B.repo, bus: B.bus, config: B.config, pushIn: pushInB, fetchFn: bridge }, 1)
  await vi.waitFor(async () => expect((await B.repo.findPushSubscription({ userId: aliceAtB.id, mode: 'rsscloud' }))?.state).toBe('active'))

  await A.service.createLocalPostAs('alice', 'Alice', 'thin-pinged across 🌩')
  await vi.waitFor(async () => {
    expect((await B.repo.getTimeline(10)).map((e) => e.content)).toContain('thin-pinged across 🌩')
  })
})
```
NOTE for the implementer: the rssCloud variant depends on A's registration challenge reaching B's `GET /rsscloud/notify` through the bridge and on A's thin ping hitting `POST http://b.example:80/rsscloud/notify` — the bridge's origin key strips the port via `u.hostname`, so `:80` routes correctly. If A's `handleRssCloudRequest` rejects `domain=b.example` because the SSRF guard resolves it, the injected `publicLookup` covers it (public address). If the WebSub loop test flakes on verification timing, `vi.waitFor` covers the async verify; do not add sleeps.

- [ ] **Step 2: Run** — `npm test -w core`. The two loop tests SHOULD pass against Tasks 1-7. If one fails it is a REAL integration defect — debug the seam (report which handler broke), do not weaken assertions.

- [ ] **Step 3: RUNNING.md** — in `docs/superpowers/documentation/RUNNING.md`, extend the "Feeds & push" section (after the existing Notes list):

```markdown
### Receiving push (push-in)

When a followed feed advertises WebSub (`rel="hub"`, also honored from HTTP
`Link` headers) or an rssCloud `<cloud>` element, core subscribes
automatically and new items arrive by push instead of waiting for the next
poll. Push-subscribed feeds still poll as a safety net, at 10× the normal
interval.

| Variable | Values | Meaning |
|---|---|---|
| `TEXTCASTER_PUSH_IN` | `on` (default) \| `off` | Kill-switch. Effective only when `TEXTCASTER_PUBLIC_URL` is set (subscriber callbacks need a public address); without it, push-in stays dormant and polling continues. |

Callback endpoints (public, no auth — verified by construction):
`GET|POST /websub/callback/<token>` (token is per-subscription and
unguessable; fat pings must carry a valid `X-Hub-Signature`, any of
sha1/sha256/sha384/sha512 — invalid pings are discarded silently) and
`GET|POST /rsscloud/notify` (thin pings only trigger a re-fetch of the
already-stored feed URL, floored at once per 30 seconds per feed).
```

- [ ] **Step 4: Full gates** — `npm test -w core && npm test -w web && npm run typecheck -w core && npm run check -w web && npm run build -w web` — all green (web untouched; a parallel session works there — if a web gate fails on clearly-parallel state, record verbatim and flag rather than touching web/).

- [ ] **Step 5: Commit**
```bash
git add core/test/federation-live.test.ts docs/superpowers/documentation/RUNNING.md
git commit -m "$(printf 'core: real-time federation loop — B receives A posts by push alone\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** §1 discovery (body via parseFeedWithMeta + REQUIRED Link header merged in ingestRemoteUser + guard/redirect-manual on endpoints) → Tasks 3-5; §2 config + dormancy notice → Tasks 1, 5; §3 migration 3 + 4 collapsed methods + H4 token stability + H3 pending TTL → Task 2 (pins) + Task 5 (R1 stored-token reuse, pinned in the retry test); §4 poller-as-scheduler, slow-poll cadence, subscribe flows, renewal thresholds, no-backoff ponytail → Task 5; §5 callbacks (state-agnostic verify, granted-lease storage, denied deletion, H1 four algorithms, H2 202-discard, body caps, rssCloud challenge/thin-ping + H5 floor + no-oracle 200) → Tasks 6-7; §6 one-parse split → Task 3; §7 money tests incl. tampered sibling + rssCloud variant + injected lookupFn note → Task 8; RUNNING.md → Task 8. Non-goals built nowhere (no unsubscribe, no backoff, no multi-hub, no web changes).
- **Placeholder scan:** every code step carries complete code; the only prose-directed edit is RUNNING.md (exact text given).
- **Type consistency:** `PushSubscription` (T2) consumed by push-in (T5-7) with camelCase fields matching the mapper; `FeedDiscovery` (T3) consumed by `choosePushTarget` (T4) and `maybeSubscribe` (T5); `PushIn` interface grows monotonically T5→T7 and the server wiring (T6-7) matches each handler signature; `PushInApi` (T6-7) mirrors the four handlers; `LookupFn` array shape matches the hardened guard (`async () => [{ address }]` everywhere); `verifySignature(body, secret, header)` identical in export (T6), fat-ping caller (T6), tests. `runPollCycle(deps, tick)` identical in T5 impl, T5 tests, T8 loop tests, server.ts.
- **Known ripple owned by Task 3:** `ingestRemoteUser`'s return-shape change updates existing assertions in `ingest.test.ts` and `federation.test.ts` — assertion shape only, never expected values.
