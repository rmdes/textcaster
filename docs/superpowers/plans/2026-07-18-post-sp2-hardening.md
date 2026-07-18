# Post-SP2 Hardening Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Core drains + exits cleanly on SIGTERM/SIGINT, and the two untested SP2 web API client functions get coverage.

**Architecture:** A new `core/src/shutdown.ts` owns the shutdown orchestration as a testable `createShutdown(deps)` (returns the signal handler) + a thin `installShutdown(deps)` wrapper that wires it to real signals. `server.ts` captures the server handle and passes a `stopLoops` closure. The repository gains a `close()` that checkpoints the WAL and closes the handle. The web tests mirror the existing `api.test.ts` fake-fetch style.

**Tech Stack:** Node 22 (native type-stripping, no build step), Hono + `@hono/node-server`, better-sqlite3, vitest, SvelteKit (web).

**Spec:** `docs/superpowers/specs/2026-07-18-post-sp2-hardening-design.md` (rev 1).

## Global Constraints

- **No TypeScript parameter properties** anywhere in `core/src` (Node native type-stripping; constructors assign fields plainly).
- **`DRAIN_MS = 5000`** is a hardcoded module constant in `shutdown.ts` — no config/env knob.
- **`ShutdownDeps` has exactly 4 fields**: `server`, `repo`, `stopLoops`, `exit` (only `exit` is optional/injected — the sole seam a test needs; never call the real `process.exit` in a test).
- **Preserve these safety properties** (do not simplify away): the `DRAIN_MS + 2000` hard backstop, `Repository.close()`'s `wal_checkpoint(TRUNCATE)`, the `started`/`done` double-guard, and `closeIdleConnections?.()` before `close`.
- **Shared checkout:** stage explicit paths, **never `git add -A`**.
- Commit-message trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Both workspaces are on `typescript ^6.0.3`; core typecheck is `npm run typecheck -w core`, web check is `npm run check -w web`.

## File Structure

- **Create `core/src/shutdown.ts`** — `ShutdownDeps`, `createShutdown(deps)` (the testable handler factory), `installShutdown(deps)` (signal wiring). One responsibility: orchestrate a clean shutdown.
- **Modify `core/src/domain/repository.ts`** — add `close(): void` to the `Repository` interface.
- **Modify `core/src/storage/sqlite.ts`** — implement `close()` on `SqliteRepository`.
- **Modify `core/src/server.ts`** — capture `server`, hold `pollTimer`/`sweepTimer`, call `installShutdown`.
- **Create `core/test/repo-close.test.ts`** — `Repository.close()` behavior.
- **Create `core/test/shutdown.test.ts`** — `createShutdown` behavior (fakes + fake timers).
- **Modify `web/src/lib/api.test.ts`** — tests for `listAdminFeeds` + `removeRemoteFeed` (functions already exist in `api.ts`).

---

### Task 1: `Repository.close()`

**Files:**
- Modify: `core/src/domain/repository.ts` (add `close(): void` to the interface, next to `deleteUserCascade(id): void` at line 14)
- Modify: `core/src/storage/sqlite.ts` (add `close()` method to `SqliteRepository`, e.g. right after `deleteUserCascade` near line 404, or after the `raw` getter)
- Test: `core/test/repo-close.test.ts`

**Interfaces:**
- Consumes: `createSqliteRepository(path)` (existing), the `raw` getter → `Database.Database` (better-sqlite3).
- Produces: `Repository.close(): void` — checkpoints WAL then closes the DB handle. Consumed by Task 2's `server.ts` wiring.

- [ ] **Step 1: Write the failing test**

Create `core/test/repo-close.test.ts`:

```ts
import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'

test('repo.close() runs the WAL checkpoint and closes the db (queries then throw)', async () => {
  const repo = await createSqliteRepository(':memory:')
  repo.close()
  // better-sqlite3 throws "The database connection is not open" on use after close.
  expect(() => repo.raw.prepare('SELECT 1').get()).toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w core -- repo-close`
Expected: FAIL — `repo.close is not a function` (method not implemented yet).

- [ ] **Step 3: Add `close()` to the `Repository` interface**

In `core/src/domain/repository.ts`, add the method to the interface (place it beside `deleteUserCascade`):

```ts
  close(): void
```

- [ ] **Step 4: Implement `close()` on `SqliteRepository`**

In `core/src/storage/sqlite.ts`, add the method to the `SqliteRepository` class (e.g. immediately after `deleteUserCascade`):

```ts
  close(): void {
    this.raw.pragma('wal_checkpoint(TRUNCATE)')
    this.raw.close()
  }
```

(`wal_checkpoint(TRUNCATE)` folds the WAL back into the main DB file so a backup taken right after a clean stop is self-contained; on a `:memory:` DB it is a harmless no-op — verified.)

- [ ] **Step 5: Run test to verify it passes + typecheck**

Run: `npm test -w core -- repo-close`
Expected: PASS (1/1).
Run: `npm run typecheck -w core`
Expected: clean (the new interface method is implemented by the only adapter).

- [ ] **Step 6: Commit**

```bash
git add core/src/domain/repository.ts core/src/storage/sqlite.ts core/test/repo-close.test.ts
git commit -m "core: add Repository.close() (WAL checkpoint + close handle)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `shutdown.ts` (`createShutdown` + `installShutdown`) and `server.ts` wiring

**Files:**
- Create: `core/src/shutdown.ts`
- Test: `core/test/shutdown.test.ts`
- Modify: `core/src/server.ts` (capture server handle; hold + reassign `pollTimer`/`sweepTimer`; call `installShutdown`; add the import)

**Interfaces:**
- Consumes: `Repository.close()` (Task 1); `serve(...)` from `@hono/node-server` returns a Node `http.Server` (has `close(cb?)`, `closeIdleConnections()`, `closeAllConnections()`).
- Produces:
  - `interface ShutdownDeps { server: { close(cb?: () => void): unknown; closeIdleConnections?(): void; closeAllConnections?(): void }; repo: { close(): void }; stopLoops: () => void; exit?: (code: number) => void }`
  - `createShutdown(deps: ShutdownDeps): (signal: string) => void` — the testable signal handler.
  - `installShutdown(deps: ShutdownDeps): void` — registers `createShutdown(deps)` on SIGTERM + SIGINT.

- [ ] **Step 1: Write the failing test**

Create `core/test/shutdown.test.ts`:

```ts
import { test, expect, vi } from 'vitest'
import { createShutdown, type ShutdownDeps } from '../src/shutdown.ts'

function fakeServer(captureCb: { cb?: () => void }) {
  return {
    close: vi.fn((cb?: () => void) => { captureCb.cb = cb }),
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(),
  }
}

test('teardown: stops loops, sheds idlers, drains, then closes db + exit(0)', () => {
  const cap: { cb?: () => void } = {}
  const server = fakeServer(cap)
  const repo = { close: vi.fn() }
  const stopLoops = vi.fn()
  const exit = vi.fn()
  const handler = createShutdown({ server, repo, stopLoops, exit } as unknown as ShutdownDeps)

  handler('SIGTERM')
  expect(stopLoops).toHaveBeenCalledTimes(1)
  expect(server.closeIdleConnections).toHaveBeenCalledTimes(1)
  expect(server.close).toHaveBeenCalledTimes(1)
  expect(repo.close).not.toHaveBeenCalled() // not until the drain callback fires
  expect(exit).not.toHaveBeenCalled()

  cap.cb!() // simulate all connections drained
  expect(repo.close).toHaveBeenCalledTimes(1)
  expect(exit).toHaveBeenCalledWith(0)
})

test('force-closes connections at DRAIN_MS; backstops exit(1) if close never completes', () => {
  vi.useFakeTimers()
  const cap: { cb?: () => void } = {}
  const server = fakeServer(cap) // close() never invokes its callback
  const exit = vi.fn()
  const handler = createShutdown({ server, repo: { close: vi.fn() }, stopLoops: vi.fn(), exit } as unknown as ShutdownDeps)

  handler('SIGTERM')
  vi.advanceTimersByTime(5000)
  expect(server.closeAllConnections).toHaveBeenCalledTimes(1)
  expect(exit).not.toHaveBeenCalled()
  vi.advanceTimersByTime(2000)
  expect(exit).toHaveBeenCalledWith(1)
  vi.useRealTimers()
})

test('a clean exit(0) makes the backstop a no-op (exit called once)', () => {
  vi.useFakeTimers()
  const cap: { cb?: () => void } = {}
  const server = fakeServer(cap)
  const exit = vi.fn()
  const handler = createShutdown({ server, repo: { close: vi.fn() }, stopLoops: vi.fn(), exit } as unknown as ShutdownDeps)

  handler('SIGTERM')
  cap.cb!() // clean exit(0)
  vi.advanceTimersByTime(7000) // past the backstop
  expect(exit).toHaveBeenCalledTimes(1)
  expect(exit).toHaveBeenCalledWith(0)
  vi.useRealTimers()
})

test('a second signal is a no-op (teardown runs once)', () => {
  const cap: { cb?: () => void } = {}
  const server = fakeServer(cap)
  const handler = createShutdown({ server, repo: { close: vi.fn() }, stopLoops: vi.fn(), exit: vi.fn() } as unknown as ShutdownDeps)
  handler('SIGTERM')
  handler('SIGINT')
  expect(server.close).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w core -- shutdown`
Expected: FAIL — cannot import `../src/shutdown.ts` (file does not exist yet).

- [ ] **Step 3: Create `core/src/shutdown.ts`**

```ts
const DRAIN_MS = 5000

export interface ShutdownDeps {
  server: { close(cb?: () => void): unknown; closeIdleConnections?(): void; closeAllConnections?(): void }
  repo: { close(): void }
  stopLoops: () => void
  exit?: (code: number) => void
}

// Returns the signal handler. Split out from installShutdown so the teardown is
// unit-testable by calling the handler directly (no real signals, no process.exit).
export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  let started = false
  let done = false
  const doExit = (code: number) => {
    if (done) return
    done = true
    exit(code)
  }
  return (signal: string) => {
    if (started) return
    started = true
    console.log(`${signal} received; shutting down`)
    deps.stopLoops()
    deps.server.closeIdleConnections?.()
    deps.server.close(() => {
      deps.repo.close()
      doExit(0)
    })
    // SSE streams never end on their own; force them closed after the drain
    // window so server.close's callback can fire.
    setTimeout(() => deps.server.closeAllConnections?.(), DRAIN_MS)
    // Backstop: exit even if the close callback never fires. unref so it never
    // itself keeps the process alive.
    setTimeout(() => doExit(1), DRAIN_MS + 2000).unref()
  }
}

export function installShutdown(deps: ShutdownDeps): void {
  const handler = createShutdown(deps)
  process.once('SIGTERM', () => handler('SIGTERM'))
  process.once('SIGINT', () => handler('SIGINT'))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w core -- shutdown`
Expected: PASS (4/4).

- [ ] **Step 5: Wire it into `core/src/server.ts`**

Add the import near the other local imports (top of file):

```ts
import { installShutdown } from './shutdown.ts'
```

Change the poll loop so its timer handle is held and reassigned (currently `setTimeout(loop, …)` discards the handle):

```ts
let tick = 0
let pollTimer: NodeJS.Timeout
async function loop() {
  tick++
  try {
    await runPollCycle({ repo, bus, config, pushIn }, tick)
  } catch (err) {
    console.error('poll cycle failed:', err instanceof Error ? err.message : err)
  }
  pollTimer = setTimeout(loop, config.pollSeconds * 1000)
}
pollTimer = setTimeout(loop, config.pollSeconds * 1000)
```

Do the same for the sweep loop:

```ts
let sweepTimer: NodeJS.Timeout
async function sweepLoop() {
  try {
    const { swept } = repo.sweepAnonymousUsers(config.anonTtlDays)
    if (swept > 0) console.log(`swept ${swept} abandoned anonymous account(s)`)
  } catch (err) {
    console.error('anon sweep failed:', err instanceof Error ? err.message : err)
  }
  sweepTimer = setTimeout(sweepLoop, 3600_000) // ponytail: fixed hourly cadence; config knob only if an operator ever asks
}
sweepTimer = setTimeout(sweepLoop, 3600_000)
```

Capture the server handle and install shutdown (replaces the bare `serve(...)` at the bottom):

```ts
const server = serve({ fetch: app.fetch, port: config.port })
console.log(`textcaster core listening on :${config.port}`)

installShutdown({ server, repo, stopLoops: () => { clearTimeout(pollTimer); clearTimeout(sweepTimer) } })
```

- [ ] **Step 6: Typecheck the wiring**

Run: `npm run typecheck -w core`
Expected: clean. In particular, `serve(...)`'s `ServerType` return structurally satisfies `ShutdownDeps.server` (Node's `http.Server` has `close`/`closeIdleConnections`/`closeAllConnections`), and `repo` satisfies `{ close(): void }` via Task 1. If TS reports `pollTimer`/`sweepTimer` "used before assigned", they are assigned synchronously before `installShutdown` runs — if strict flow analysis still objects, use `let pollTimer!: NodeJS.Timeout` (definite-assignment) rather than widening to `| undefined`.

- [ ] **Step 7: Run the full core suite**

Run: `npm test -w core`
Expected: all pass (no regression; `server.ts` runs only at process start, so tests don't import it).

- [ ] **Step 8: Commit**

```bash
git add core/src/shutdown.ts core/test/shutdown.test.ts core/src/server.ts
git commit -m "core: graceful shutdown on SIGTERM/SIGINT (drain, force-close SSE, checkpoint + exit)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: SP2 web API tests (`listAdminFeeds` + `removeRemoteFeed`)

**Files:**
- Modify: `web/src/lib/api.test.ts` (add tests; extend the existing import from `./api.ts`)

**Interfaces:**
- Consumes (both already exist in `web/src/lib/api.ts`, added in SP2 Task 4):
  - `listAdminFeeds(f: typeof fetch): Promise<Array<{ handle: string; displayName: string; feedUrl: string | null }>>` — GETs `${base()}/admin/feeds`, returns `.feeds`, throws `errorMessage(res, 'listAdminFeeds failed')` on non-ok.
  - `removeRemoteFeed(f: typeof fetch, handle: string): Promise<void>` — DELETEs `${base()}/users/${encodeURIComponent(handle)}`, throws `errorMessage(res, 'removeRemoteFeed failed')` on non-ok.
- Produces: nothing (test-only). These are coverage-fill (characterization) tests for existing, correct code — they pass on first run; a regression in either function is what they would catch.

- [ ] **Step 1: Extend the import in `web/src/lib/api.test.ts`**

Change the existing import line (currently `import { getTimeline, createPost, addRemoteUser, getMe } from './api.ts'`) to:

```ts
import { getTimeline, createPost, addRemoteUser, getMe, listAdminFeeds, removeRemoteFeed } from './api.ts'
```

- [ ] **Step 2: Add the four tests (append to the file)**

```ts
test('listAdminFeeds returns the feeds array and GETs /admin/feeds', async () => {
	const f = vi.fn(
		async () => new Response(JSON.stringify({ feeds: [{ handle: 'a', displayName: 'A', feedUrl: 'https://x/f' }] }), { status: 200 })
	)
	const feeds = await listAdminFeeds(f as unknown as typeof fetch)
	expect(feeds[0].handle).toBe('a')
	expect(f).toHaveBeenCalledWith('http://localhost:8787/admin/feeds')
})

test('listAdminFeeds surfaces the core error message', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ error: 'admin only' }), { status: 403 }))
	await expect(listAdminFeeds(f as unknown as typeof fetch)).rejects.toThrow('admin only')
})

test('removeRemoteFeed DELETEs the url-encoded handle', async () => {
	const f = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 200 }))
	await removeRemoteFeed(f as unknown as typeof fetch, 'a b')
	expect(f).toHaveBeenCalledWith('http://localhost:8787/users/a%20b', { method: 'DELETE' })
})

test('removeRemoteFeed surfaces the core error message', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ error: 'not a remote feed' }), { status: 409 }))
	await expect(removeRemoteFeed(f as unknown as typeof fetch, 'x')).rejects.toThrow('not a remote feed')
})
```

- [ ] **Step 3: Run the new tests**

Run: `npm test -w web -- api`
Expected: PASS — including the four new cases (they lock in the existing correct behavior: request shape + `.feeds` extraction + `encodeURIComponent` + error surfacing).

- [ ] **Step 4: Typecheck + full web suite (no regression)**

Run: `npm run check -w web`
Expected: 0 errors.
Run: `npm test -w web`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/api.test.ts
git commit -m "web: cover listAdminFeeds + removeRemoteFeed api clients

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Notes

- Tasks are ordered by dependency: Task 1 (`repo.close`) is consumed by Task 2's `server.ts` wiring; Task 2's shutdown unit test is independent of Task 1 (it uses a fake repo). Task 3 (web) is fully independent and could run in any order.
- `server.ts` is a top-level bootstrap script (work runs at import), so it is deliberately not imported by tests; its wiring is verified by `npm run typecheck -w core` + review, and the shutdown *logic* is fully unit-tested via `createShutdown` in Task 2.
- Watch for the parallel session's in-flight edits in this shared checkout: confirm `npm test -w core` is green on the current HEAD before starting, so a pre-existing red isn't misattributed to this work.
