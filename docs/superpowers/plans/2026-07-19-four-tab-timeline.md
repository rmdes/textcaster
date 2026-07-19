# Four-Tab Web Timeline (SP2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-19-four-tab-timeline-design.md` (**rev 3**)
**Rev 1** — clean-context correctness review + ponytail review folded
(`docs/superpowers/reviews/2026-07-19-four-tab-timeline-plan-review.md`):
fixture typing fix, thread-select coverage, merged web-plumbing task, trimmed
tests, `TABS`-derived tab links.

**Goal:** Turn the web home (`/`) into a four-tab timeline — Local · Federated · Personal · Public — with per-tab live SSE filtering and auth-dependent default tab.

**Architecture:** Tabs are `?tab=` values on the single `/` route; each tab maps to an existing core `GET /timeline` filter. One small core change adds `author.feedType` to entries (5 joined selects + shared mapper) and makes `followed_by` self-inclusive. Live prepends filter client-side per tab via `lens.ts`, like existing author/thread pages.

**Tech Stack:** Core: Hono + Kysely/better-sqlite3 (native type stripping — no TS parameter properties). Web: SvelteKit, Svelte 5 runes.

## Global Constraints

- Shared checkout: a parallel session commits on main. **Never `git add -A`** — stage explicit paths. Re-read files before editing; rebase each task on live HEAD.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Core tests on host: `npm run -w core test -- <name>`; typecheck: `npm run -w core typecheck`.
- Web tests ONLY in-container: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- <name>`; typecheck: `docker compose exec -T web npm run check -w web`.
- Type stripping ⇒ vitest passes on type errors. **Every task runs its typecheck before DONE.** Editor diagnostics on fresh files are often stale — trust the check command.
- No raw hex in components — only `--color-*` tokens from `web/src/app.css`. `{@html}` stays confined to `PostBody.svelte`.
- Core route work follows the project `hono` skill; web UI tasks invoke `ui-ux-pro-max:ui-ux-pro-max` and follow `design-system/textcaster/MASTER.md`; Svelte tasks consult `svelte-skills` (svelte-runes, sveltekit-data-flow).
- Tab vocabulary everywhere: `local | federated | personal | public`.

---

### Task 1: Core — `author.feedType` on all client-facing entries

**Files:**
- Modify: `core/src/storage/sqlite.ts` (`JoinedRow` + `joinedRowToEntry` ~line 34-41; five select lists at ~226 `getTimeline`, ~252 `getTimelineAfter`, ~285 `getRecentLocalPosts`, ~309 `getThread`, ~411 `listRepliesByPostId`)
- Test: `core/test/timeline-tabs.test.ts`

**Interfaces:**
- Consumes: `FeedType = 'person' | 'webfeed' | 'instance'` (`core/src/domain/types.ts:7`, already imported in sqlite.ts for `UsersTable`).
- Produces: every `TimelineEntry.author` from timeline/thread/replies/SSE-replay reads carries `feedType: FeedType | null` (local authors → `null`). Web Task 3 relies on this field reaching `/timeline` JSON and SSE `post` payloads.

- [ ] **Step 1: Write the failing tests**

In `core/test/timeline-tabs.test.ts`:

1. **Fixture typing (typecheck gate):** `makeAuth` requires the concrete class, not the interface — `let repo: Repository` would fail `npm run -w core typecheck` with TS2345. Change the declaration to the type `makeAuth` takes (import it the same way `core/test/auth-helper.ts` does):

```ts
import { createSqliteRepository, type SqliteRepository } from '../src/storage/sqlite.ts'
```

and `let repo: Repository` → `let repo: SqliteRepository`. Delete the now-unused `Repository` type import.

2. **Add harness imports** (same style as `core/test/api.test.ts`):

```ts
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth } from './auth-helper.ts'
```

3. **New tests** inside the `describe('timeline tabs', …)` block (fixture already creates alice/webfeed/instance + three posts). The HTTP test also closes SP1's deferred "no HTTP-layer test for `/timeline` source/feed_type params" minor; the `getThread` test covers a second select site (the shared mapper can't catch a select list that forgot the column):

```ts
  it('GET /timeline serves author.feedType; source/feed_type params filter over HTTP', async () => {
    const bus = createEventBus()
    const app = createApp({ service: createService(repo, bus), bus, token: 'secret', auth: makeAuth(repo), users: repo })
    const all = await app.request('/timeline')
    expect(all.status).toBe(200)
    const body = await all.json()
    const feedTypeOf = (id: string) => body.timeline.find((e: { id: string }) => e.id === id).author.feedType
    expect(feedTypeOf(instancePostId)).toBe('instance')
    expect(feedTypeOf(webfeedPostId)).toBe('webfeed')
    expect(feedTypeOf(localPostId)).toBeNull()
    const fed = await (await app.request('/timeline?feed_type=instance')).json()
    expect(fed.timeline.map((e: { id: string }) => e.id)).toEqual([instancePostId])
    const local = await (await app.request('/timeline?source=local')).json()
    expect(local.timeline.map((e: { id: string }) => e.id)).toEqual([localPostId])
  })

  it('getThread entries carry author.feedType (second select site)', async () => {
    const thread = await repo.getThread(webfeedPostId)
    expect(thread[0].author.feedType).toBe('webfeed')
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run -w core test -- timeline-tabs`
Expected: FAIL — `expected undefined to be 'instance'` (feedType absent from `joinedRowToEntry`).

- [ ] **Step 3: Implement**

In `core/src/storage/sqlite.ts`:

1. `JoinedRow` type gains the field (keep one line, matching file style):

```ts
type JoinedRow = PostsTable & { u_id: string; u_kind: 'local' | 'remote'; u_handle: string; u_display_name: string; u_feed_url: string | null; u_created_at: string; u_auth_user_id: string | null; u_feed_type: FeedType | null }
```

2. `joinedRowToEntry` author literal gains `feedType: r.u_feed_type`:

```ts
    author: { id: r.u_id, kind: r.u_kind, handle: r.u_handle, displayName: r.u_display_name, feedUrl: r.u_feed_url, createdAt: r.u_created_at, authUserId: r.u_auth_user_id, feedType: r.u_feed_type },
```

3. In each of the FIVE select lists (grep `u_auth_user_id` to find all five), append `'users.feed_type as u_feed_type'`:

```ts
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at', 'users.auth_user_id as u_auth_user_id', 'users.feed_type as u_feed_type'])
```

`FeedType` is already imported in sqlite.ts. No cast anywhere — `UsersTable.feed_type` is already `FeedType | null`.

- [ ] **Step 4: Run tests + typecheck**

Run: `npm run -w core test -- timeline-tabs` → PASS.
Run: `npm run -w core test` → full suite green (a parallel session may have added tests — only YOUR files' failures block).
Run: `npm run -w core typecheck` → 0 errors (this catches both the fixture typing and any missed select site's type).

- [ ] **Step 5: Commit**

```bash
git add core/src/storage/sqlite.ts core/test/timeline-tabs.test.ts
git commit -m "core: author.feedType on timeline/thread/SSE entries (5 joined selects + shared mapper)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Core — self-inclusive `followed_by` (river includes its owner)

**Files:**
- Modify: `core/src/storage/sqlite.ts` (`getTimeline` followedBy branch, ~line 235-239)
- Test: `core/test/timeline-tabs.test.ts`

**Interfaces:**
- Consumes: Task 1's fixture state (alice authors `localPostId`).
- Produces: `getTimeline(limit, before, { followedBy })` returns the follower's own posts too. Web Task 4's Personal tab and the existing `/u/:handle/following` page inherit this semantics (accepted in spec rev 1).

- [ ] **Step 1: Update the existing assertion**

In `core/test/timeline-tabs.test.ts`, the Personal-river test currently expects exactly `[webfeedPostId]`. **This red is planned — do NOT "fix" it by weakening the implementation.** Replace the test with:

```ts
  it('Personal river: own + webfeed posts, excluding the instance despite the stale follow', async () => {
    const tl = await repo.getTimeline(10, undefined, { followedBy: alice })
    // webfeed post (01-02) sorts before alice's own local post (01-01)
    expect(tl.map((e) => e.id)).toEqual([webfeedPostId, localPostId])
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run -w core test -- timeline-tabs`
Expected: FAIL — received `[webfeedPostId]`, missing `localPostId` (no self-inclusion yet).

- [ ] **Step 3: Implement**

In `getTimeline`'s followedBy branch, replace the single `in`-subquery where-clause with an OR (keep the instance-exclusion clause below it untouched). Kysely 0.29 supports `eb('col', 'in', eb.selectFrom(...))` inside `eb.or([...])` — verified against the installed package:

```ts
    if (filter?.followedBy) {
      const followerId = filter.followedBy
      // Personal river includes its owner — no self-follow edge exists (SP2 rev 1).
      q = q.where((eb) =>
        eb.or([
          eb('posts.author_id', '=', followerId),
          eb('posts.author_id', 'in', eb.selectFrom('follows').select('followed_id').where('follower_id', '=', followerId)),
        ])
      )
      q = q.where((eb) => eb.or([eb('users.feed_type', 'is', null), eb('users.feed_type', '!=', 'instance')])) // Decision B: personal river never shows instances
    }
```

(The instance-exclusion stays AND'd outside the OR: the follower is local, `feed_type` NULL, so self rows pass it.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npm run -w core test -- timeline-tabs` → PASS (all tests, including the untouched Local/Federated/Public ones).
Run: `npm run -w core test` → full suite green. The only other `followedBy` content assertion is `service.test.ts` (follower authors no posts — self-inclusion is a no-op there); if it fails, your OR clause is wrong — STOP and re-read.
Run: `npm run -w core typecheck` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add core/src/storage/sqlite.ts core/test/timeline-tabs.test.ts
git commit -m "core: followed_by timeline includes the follower's own posts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Web plumbing — entry `feedType`, lens kinds, tab helper, timeline params

**Files:**
- Modify: `web/src/lib/types.ts` (author object type, line 10)
- Modify: `web/src/lib/lens.ts`
- Modify: `web/src/lib/api.ts` (`getTimeline`, lines 21-38)
- Create: `web/src/lib/tabs.ts`
- Test: `web/src/lib/lens.test.ts`, `web/src/lib/api.test.ts` (extend), `web/src/lib/tabs.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `author.feedType` over the wire (types only here — no fetch changes).
- Produces (Tasks 4/5 depend on these exact names):
  - `TimelineEntry['author'].feedType?: 'person' | 'webfeed' | 'instance' | null`
  - `Lens` union gains `{ kind: 'source'; source: 'local' }` and `{ kind: 'feedType'; feedType: 'instance' }`; `keepEvent` handles both.
  - `getTimeline(f, opts)` accepts `source?: 'local'` / `feedType?: 'instance'` → emits `source=local` / `feed_type=instance` params.
  - `tabs.ts`: `export const TABS = ['local', 'federated', 'personal', 'public'] as const`; `export type Tab = (typeof TABS)[number]`; `export function resolveTab(raw: string | null, me: { isAnonymous: boolean } | null): Tab`; `export function tabFilter(tab: Tab, meHandle: string | undefined): { source?: 'local'; feedType?: 'instance'; followedBy?: string }`.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/lib/lens.test.ts` (the `entry(authorId)` helper at the top builds a `source: 'remote'` entry — reuse it):

```ts
test('source lens keeps only local posts', () => {
  expect(keepEvent({ ...entry('a'), source: 'local' }, { kind: 'source', source: 'local' })).toBe(true)
  expect(keepEvent(entry('a'), { kind: 'source', source: 'local' })).toBe(false)
})

test('feedType lens keeps only instance authors', () => {
  const e = entry('a')
  e.author.feedType = 'instance'
  expect(keepEvent(e, { kind: 'feedType', feedType: 'instance' })).toBe(true)
  expect(keepEvent(entry('b'), { kind: 'feedType', feedType: 'instance' })).toBe(false) // feedType absent → dropped
})
```

Create `web/src/lib/tabs.test.ts`:

```ts
import { test, expect } from 'vitest'
import { resolveTab, tabFilter } from './tabs'

const registered = { isAnonymous: false }
const anon = { isAnonymous: true }

test('defaults: registered → personal, anon → public, guest → public', () => {
  expect(resolveTab(null, registered)).toBe('personal')
  expect(resolveTab(null, anon)).toBe('public')
  expect(resolveTab(null, null)).toBe('public')
})

test('valid explicit tabs pass through; anon may select personal', () => {
  expect(resolveTab('local', null)).toBe('local')
  expect(resolveTab('personal', anon)).toBe('personal')
})

test('invalid tab and guest-on-personal fall back to the viewer default', () => {
  expect(resolveTab('bogus', registered)).toBe('personal')
  expect(resolveTab('bogus', null)).toBe('public')
  expect(resolveTab('personal', null)).toBe('public')
})

test('tabFilter maps each tab to its getTimeline opts', () => {
  expect(tabFilter('local', undefined)).toEqual({ source: 'local' })
  expect(tabFilter('federated', undefined)).toEqual({ feedType: 'instance' })
  expect(tabFilter('personal', 'alice')).toEqual({ followedBy: 'alice' })
  expect(tabFilter('public', undefined)).toEqual({})
})
```

Append to `web/src/lib/api.test.ts` (match the file's standing mock style — `as unknown as typeof fetch`, not `as never`):

```ts
test('getTimeline threads source and feed_type params', async () => {
  const f = vi.fn(async () => new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 }))
  await getTimeline(f as unknown as typeof fetch, { source: 'local' })
  expect(String(f.mock.calls[0][0])).toContain('source=local')
  await getTimeline(f as unknown as typeof fetch, { feedType: 'instance' })
  expect(String(f.mock.calls[1][0])).toContain('feed_type=instance')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- lens`
Expected: FAIL — under type stripping the unknown lens kinds fall through to the `followed` branch: TypeError on `lens.followIds`.
Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- tabs`
Expected: FAIL — `Cannot find module './tabs'`.
Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- api`
Expected: FAIL — built URL lacks `source=local` (opt silently ignored).

- [ ] **Step 3: Implement**

`web/src/lib/types.ts` line 10, author gains `feedType`:

```ts
	author: { id: string; handle: string; displayName: string; kind: 'local' | 'remote'; feedUrl?: string | null; feedType?: 'person' | 'webfeed' | 'instance' | null }
```

`web/src/lib/lens.ts` becomes:

```ts
import type { TimelineEntry } from './types'

export type Lens =
  | { kind: 'author'; authorId: string }
  | { kind: 'followed'; followIds: Set<string> }
  | { kind: 'thread'; rootId: string }
  | { kind: 'source'; source: 'local' }
  | { kind: 'feedType'; feedType: 'instance' }

export function keepEvent(entry: TimelineEntry, lens: Lens): boolean {
  if (lens.kind === 'author') return entry.author.id === lens.authorId
  if (lens.kind === 'thread') return entry.id === lens.rootId || entry.threadRootId === lens.rootId
  if (lens.kind === 'source') return entry.source === lens.source
  if (lens.kind === 'feedType') return entry.author.feedType === lens.feedType
  return lens.followIds.has(entry.author.id)
}
```

Create `web/src/lib/tabs.ts`:

```ts
// The four home-timeline tabs — filters over the one shared post pool (SP2).
export const TABS = ['local', 'federated', 'personal', 'public'] as const
export type Tab = (typeof TABS)[number]

// Resolve ?tab= + viewer state to the tab actually rendered. Guests can never
// resolve to personal (no handle to filter by); anons can select it explicitly
// (they have a follow graph) but default to public.
export function resolveTab(raw: string | null, me: { isAnonymous: boolean } | null): Tab {
	if (raw && (TABS as readonly string[]).includes(raw) && !(raw === 'personal' && !me)) return raw as Tab
	return me && !me.isAnonymous ? 'personal' : 'public'
}

export function tabFilter(tab: Tab, meHandle: string | undefined): { source?: 'local'; feedType?: 'instance'; followedBy?: string } {
	if (tab === 'local') return { source: 'local' }
	if (tab === 'federated') return { feedType: 'instance' }
	if (tab === 'personal') return { followedBy: meHandle }
	return {}
}
```

In `web/src/lib/api.ts`, extend `getTimeline`'s opts type and query builder:

```ts
export async function getTimeline(
	f: typeof fetch,
	opts: { before?: string; followedBy?: string; author?: string; source?: 'local'; feedType?: 'instance' } = {}
): Promise<TimelinePage> {
```

and after the existing three `params.push` lines:

```ts
	if (opts.source) params.push(`source=${opts.source}`)
	if (opts.feedType) params.push(`feed_type=${opts.feedType}`)
```

- [ ] **Step 4: Run tests + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- lens` → PASS.
Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- tabs` → PASS.
Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- api` → PASS.
Run: `docker compose exec -T web npm run check -w web` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/types.ts web/src/lib/lens.ts web/src/lib/lens.test.ts web/src/lib/tabs.ts web/src/lib/tabs.test.ts web/src/lib/api.ts web/src/lib/api.test.ts
git commit -m "web: feedType on entries; source/feedType lenses; tab helper; timeline filter params

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Web — home load resolves tabs; actions preserve them

**Files:**
- Modify: `web/src/routes/+page.server.ts`
- Test: `web/src/routes/page.load.test.ts`, `web/src/routes/page.actions.test.ts`

**Interfaces:**
- Consumes: `resolveTab` / `tabFilter` / `TABS` (Task 3), `getFollowing` (`$lib/api`, returns authors with `feedType` after Task 3), layout `me` via `await parent()` (`+layout.server.ts` returns `{ me, mailEnabled }`).
- Produces (Task 5 renders these): load returns `tab: Tab` always (including the catch branch) and `followIds?: string[]` (only on personal + first page: `[me.user.id, ...following-minus-instances]`). Actions: `compose` redirects to `/?tab=<valid tab>` (else `/`); `addRemote` redirects to `/?tab=public&feed=<handle>`. `deletePost` stays redirect-free (`{ removed: true }`) — its form action URL alone preserves the tab (no-JS re-renders land on the POSTed URL; enhanced submits don't navigate). Spec rev 3 reflects this.

- [ ] **Step 1: Write the failing tests**

`web/src/routes/page.load.test.ts` — the existing three tests call `load({ fetch, url } as never)`; **add `parent: async () => ({ me: null })` to each** (expected amendment, not scope drift — the new load awaits `parent()`), and add `tab: 'public'` to the coreDown `toEqual` object. Then append:

```ts
const meOf = (handle: string, isAnonymous = false) => ({
	user: { id: 'me1', handle, displayName: handle, kind: 'local' as const },
	isAnonymous
})

test('registered default resolves to personal: followed_by filter, self-first followIds, instances excluded', async () => {
	const fetch = vi.fn(async (url: string | URL) =>
		String(url).includes('/follows')
			? new Response(
					JSON.stringify({
						following: [
							{ id: 'f1', handle: 'w', displayName: 'W', kind: 'remote', feedType: 'webfeed' },
							{ id: 'f2', handle: 'i', displayName: 'I', kind: 'remote', feedType: 'instance' }
						]
					}),
					{ status: 200 }
				)
			: new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 })
	)
	const result = (await load({ fetch, url: new URL('http://x/'), parent: async () => ({ me: meOf('alice') }) } as never)) as {
		tab: string
		followIds?: string[]
	}
	const calls = fetch.mock.calls.map((c) => String(c[0]))
	expect(calls.some((s) => s.includes('followed_by=alice'))).toBe(true)
	expect(result.tab).toBe('personal')
	expect(result.followIds).toEqual(['me1', 'f1'])
})

test('paginated personal load skips the follows fetch', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 }))
	const result = (await load({
		fetch,
		url: new URL('http://x/?tab=personal&before=ts~p9'),
		parent: async () => ({ me: meOf('alice') })
	} as never)) as { tab: string; followIds?: string[] }
	expect(fetch.mock.calls.map((c) => String(c[0])).some((s) => s.includes('/follows'))).toBe(false)
	expect(result.tab).toBe('personal')
	expect(result.followIds).toBeUndefined()
})

test('explicit ?tab=local filters by source; guest-on-personal keeps the public firehose', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 }))
	const local = (await load({ fetch, url: new URL('http://x/?tab=local'), parent: async () => ({ me: null }) } as never)) as { tab: string }
	expect(fetch.mock.calls.map((c) => String(c[0])).some((s) => s.includes('source=local'))).toBe(true)
	expect(local.tab).toBe('local')
	const guest = (await load({ fetch, url: new URL('http://x/?tab=personal'), parent: async () => ({ me: null }) } as never)) as { tab: string }
	expect(guest.tab).toBe('public')
	expect(fetch.mock.calls.map((c) => String(c[0])).some((s) => s.includes('followed_by'))).toBe(false)
})
```

(No `/peers` mock branches: `getPeers` is `.catch(() => [])`-guarded and the default `{timeline...}` JSON parses harmlessly for it — same as the existing tests.)

`web/src/routes/page.actions.test.ts` — append (reuse `formRequest`/`sessionedEvent` helpers; `sessionedEvent` pins `url: new URL('http://x/')`, so override it):

```ts
test('compose redirects back to the active tab; invalid tab params are dropped', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 201 }))
	const good = sessionedEvent(formRequest('compose', { content: 'hi' }), fetch)
	good.url = new URL('http://x/?tab=local&/compose')
	await expect(actions.compose(good as never)).rejects.toMatchObject({ status: 303, location: '/?tab=local' })
	const bad = sessionedEvent(formRequest('compose', { content: 'hi' }), fetch)
	bad.url = new URL('http://x/?tab=evil&/compose')
	await expect(actions.compose(bad as never)).rejects.toMatchObject({ status: 303, location: '/' })
})

test('addRemote redirects to the public tab where the new feed is visible', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ user: {} }), { status: 201 }))
	const event = sessionedEvent(formRequest('addRemote', { handle: 'news', feedUrl: 'https://ex.com/f.xml' }), fetch)
	await expect(actions.addRemote(event as never)).rejects.toMatchObject({ status: 303, location: '/?tab=public&feed=news' })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- page.load`
Expected: FAIL — `result.tab` undefined; no `followed_by` in any call.
Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- page.actions`
Expected: FAIL — compose redirect location is `/`, addRemote's is `/?feed=news`.

- [ ] **Step 3: Implement**

Replace `web/src/routes/+page.server.ts`'s load and the two redirect lines (deletePost action unchanged):

```ts
import type { PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { getTimeline, getPeers, getFollowing, createPost, addRemoteUser, deletePost } from '$lib/api'
import { enrichEntries } from '$lib/server/render'
import { authedFetch, cookieHeader, ensureSessionFetch } from '$lib/server/session'
import { TABS, resolveTab, tabFilter } from '$lib/tabs'

export const load: PageServerLoad = async ({ fetch, url, parent }) => {
	const before = url.searchParams.get('before') ?? undefined
	// Post-redirect success flash for add-remote (same SSR pattern as login's ?reset=1).
	const addedFeed = url.searchParams.get('feed') ?? undefined
	const isFirstPage = !before
	const { me } = await parent()
	const tab = resolveTab(url.searchParams.get('tab'), me)
	try {
		// followIds feed the live lens only, and LiveTimeline mounts on the first page only.
		const timelineP = getTimeline(fetch, { before, ...tabFilter(tab, me?.user.handle) })
		const followingP = tab === 'personal' && isFirstPage && me ? getFollowing(fetch, me.user.handle) : Promise.resolve(null)
		const [{ timeline, nextCursor }, following] = await Promise.all([timelineP, followingP])
		// Widget data, never load-bearing: a peers failure must not down the page.
		const peers = await getPeers(fetch).catch(() => [])
		// Self first (the river includes its owner); vestigial instance follows never reach the lens.
		const followIds = following && me ? [me.user.id, ...following.filter((u) => u.feedType !== 'instance').map((u) => u.id)] : undefined
		return { timeline: enrichEntries(timeline), nextCursor, isFirstPage, peers, addedFeed, tab, followIds }
	} catch {
		return { timeline: [], nextCursor: null, isFirstPage, coreDown: true, peers: [], addedFeed, tab }
	}
}

// Named-action URLs replace the query string, so forms carry ?tab=<tab>&/action
// (SvelteKit takes the first param starting with '/'). Echo only known tabs.
const tabHome = (url: URL): string => {
	const raw = url.searchParams.get('tab')
	return raw && (TABS as readonly string[]).includes(raw) ? `/?tab=${raw}` : '/'
}
```

In `compose`, the final line becomes:

```ts
		throw redirect(303, tabHome(event.url))
```

In `addRemote`, the final line becomes (flash copy is only true on Public — the form itself is repointed in SP3):

```ts
		throw redirect(303, `/?tab=public&feed=${encodeURIComponent(handle)}`)
```

- [ ] **Step 4: Run tests + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- page.load` → PASS (including the three pre-existing tests you extended).
Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- page.actions` → PASS.
Run: `docker compose exec -T web npm run check -w web` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/+page.server.ts web/src/routes/page.load.test.ts web/src/routes/page.actions.test.ts
git commit -m "web: home load resolves ?tab (auth-aware default); actions preserve the active tab

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Web — tab bar UI, per-tab live lens, personal empty state

**Implementer note:** UI task — invoke `ui-ux-pro-max:ui-ux-pro-max` first and follow `design-system/textcaster/MASTER.md`; consult `svelte-skills:svelte-runes` for `$derived.by`.

**Files:**
- Modify: `web/src/routes/+page.svelte`

**Interfaces:**
- Consumes: `data.tab`, `data.followIds` (Task 4), `keepEvent`/`Lens`/`TABS` (Task 3). `data.me` is already merged from the layout.
- Produces: the visible four-tab home. No downstream task.

- [ ] **Step 1: Script changes**

In the `<script>` block, add imports:

```ts
	import { keepEvent, type Lens } from '$lib/lens'
	import { TABS } from '$lib/tabs'
```

After the `posts` derived, add the lens and replace the existing `onPost` (keep a single definition):

```ts
	// Public river is lensless; the stream is a firehose, so every other tab
	// filters incoming SSE events client-side (same pattern as author/thread pages).
	const lens = $derived.by((): Lens | null => {
		if (data.tab === 'local') return { kind: 'source', source: 'local' }
		if (data.tab === 'federated') return { kind: 'feedType', feedType: 'instance' }
		if (data.tab === 'personal') return { kind: 'followed', followIds: new Set(data.followIds ?? []) }
		return null
	})

	function onPost(entry: TimelineEntry) {
		if (lens && !keepEvent(entry, lens)) return
		const r = mergeIncoming(live, edited, entry, pageIds)
		live = r.live
		edited = r.edited
	}
```

- [ ] **Step 2: Markup changes**

1. Top of `<main>` (before the `coreDown` notice), the tab bar — links derive from `TABS`, labels via CSS capitalize (no hand-built label const):

```svelte
		<nav class="tabs" aria-label="Timeline">
			{#each TABS as t (t)}
				<a href="/?tab={t}" aria-current={data.tab === t ? 'page' : undefined}>{t}</a>
			{/each}
		</nav>
```

2. `ComposerDialog` call: `action="?tab={data.tab}&/compose"` (replaces `action="?/compose"`).

3. Add-remote form: `action="?tab={data.tab}&/addRemote"` (replaces `?/addRemote`) — on `fail()` the error re-renders on the same tab.

4. deletePost form inside the entry loop: `action="?tab={data.tab}&/deletePost"`.

5. Personal empty state, directly before `<ul class="timeline">`:

```svelte
		{#if data.tab === 'personal' && posts.length === 0 && !data.coreDown}
			<p class="notice">Your personal river is empty — <a href="/u/{data.me?.user.handle}/following">follow people and feeds</a> to fill it.</p>
		{/if}
```

6. Older-posts link carries the tab:

```svelte
		{#if data.nextCursor}
			<a class="older" href="/?tab={data.tab}&before={encodeURIComponent(data.nextCursor)}">Older posts</a>
		{/if}
```

- [ ] **Step 3: Styles**

Append to the `<style>` block — the `.admin-nav` pattern (`web/src/routes/admin/+layout.svelte`) plus the MASTER.md deltas (focus ring, transitions) and `text-transform: capitalize` for the `TABS`-derived labels. Tokens only, no raw hex:

```css
	/* Tab bar: .admin-nav pattern + focus ring. Fixed 44px row so live
	   prepends below never shift it (MASTER: jank-free prepends). */
	.tabs {
		display: flex;
		gap: var(--space-md);
		border-bottom: 1px solid var(--color-border);
		margin-bottom: var(--space-md);
	}

	.tabs a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 var(--space-xs);
		color: var(--color-secondary);
		font-weight: 600;
		text-decoration: none;
		text-transform: capitalize;
		border-bottom: 2px solid transparent;
		transition:
			color 200ms,
			border-color 200ms;
	}

	.tabs a:hover {
		color: var(--color-foreground);
	}

	.tabs a:focus-visible {
		outline: none;
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-ring) 15%, transparent);
	}

	.tabs a[aria-current='page'] {
		color: var(--color-foreground);
		border-bottom-color: var(--color-accent);
	}
```

- [ ] **Step 4: Verify**

Run: `docker compose exec -T web npm run check -w web` → 0 errors.
Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web` → full web suite green.
Manual smoke (dev stack must be up — `docker compose up -d`): open `http://127.0.0.1:5173/` — guest sees Public active; `/?tab=local` shows only local posts and "Older posts" (if present) carries `tab=local`. Check BOTH themes via the toggle.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/+page.svelte
git commit -m "web: four-tab home timeline — tab bar, per-tab live lens, personal empty state

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Docs + integrated verification

**Files:**
- Modify: `README.md` (lines 23-26 "One live timeline" + lines 91-94 roadmap)
- Test: none (docs) — plus the full-suite gate below.

**Interfaces:**
- Consumes: everything shipped in Tasks 1-5.
- Produces: README reflects the tabs; whole feature verified integrated.

- [ ] **Step 1: README**

Replace the "One live timeline." paragraph (lines 23-26):

```markdown
**One live timeline, four tabs.** Local posts and polled-in remote feed items
share a single server-rendered timeline that updates live over SSE
(Server-Sent Events), filtered through four tabs: **Local** (posts born here),
**Federated** (connected Textcaster instances), **Personal** (you + who you
follow), and **Public** (everything). Logged-in users land on Personal, guests
on Public. Works with JavaScript off — tabs are plain links and the live
updates are a progressive enhancement, not a requirement.
```

In the roadmap paragraph (lines 91-94), delete `timeline tabs (personal / local / remote) and` so the OPML clause remains:

```markdown
Not built yet, in rough order: IndieAuth sign-in and Micropub posting-in;
Webmention; OPML-category filtering of sources; media/enclosures and avatar
harvesting from source feeds. Trackable in [`docs/superpowers/specs/`](docs/superpowers/specs/).
```

- [ ] **Step 2: Integrated verification (evidence before assertions)**

Run and paste outputs:
- `npm run -w core test` → all green
- `npm run -w core typecheck` → 0 errors
- `docker compose exec -T web env -u CORE_API_URL npm test -w web` → all green
- `docker compose exec -T web npm run check -w web` → 0 errors

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README — four-tab timeline shipped, roadmap trimmed

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of scope (do not build here)

Subscribe/manage surfaces, the stale add-remote form repoint, admin cap UI, feed-type re-tag, feed-type badges on entries, SSE server-side filters, tab persistence — all SP3 or YAGNI (spec "Out of scope").
