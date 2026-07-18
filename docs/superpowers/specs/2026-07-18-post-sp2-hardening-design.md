# Post-SP2 Hardening Batch — Design

**Status:** design
**Date:** 2026-07-18
**Source:** the 2026-07-18 deferred-minors verification sweep (see the SDD ledger's
"VERIFICATION SWEEP" section). Two items earned a fix; the rest were either
already resolved or documented protocol residuals.

## Context

The verification sweep confirmed most ledgered "deferred" minors were already
fixed by later milestones. Two remain worth doing now:

1. **No graceful shutdown** — `core/src/server.ts` registers zero
   `SIGTERM`/`SIGINT` handlers. On every Cloudron/Docker stop or redeploy the
   process is killed mid-flight: in-flight HTTP requests are dropped, open SSE
   streams are severed without warning, the poll/sweep loops die mid-cycle, and
   the SQLite WAL is left un-checkpointed (recovered on next boot, but not
   clean).
2. **Untested SP2 web API functions** — `listAdminFeeds` and `removeRemoteFeed`
   (added to `web/src/lib/api.ts` in SP2 Task 4) have no tests, while their
   siblings `createPost`/`addRemoteUser`/`getMe` do (`web/src/lib/api.test.ts`).

Both are independent and small. They ship together as one hardening batch.

## Goal

Core drains and exits cleanly on a stop signal, and the SP2 client API surface
gets the same test coverage as the rest of `$lib/api`.

## Design

### 1. `core/src/shutdown.ts` — `installShutdown`

A new module owning the shutdown orchestration, kept out of `server.ts` so it is
unit-testable without spawning a process or calling the real `process.exit`.

```ts
export interface ShutdownDeps {
  server: { close(cb?: () => void): unknown; closeIdleConnections?(): void; closeAllConnections?(): void }
  repo: { close(): void }
  stopLoops: () => void            // clears the poll + sweep timers (server.ts closes over the current handles)
  exit?: (code: number) => void    // default process.exit — the one seam a test needs (never the real exit in tests)
}

// DRAIN_MS = 5000 is a hardcoded module constant in shutdown.ts (no operator knob;
// the test advances vi fake timers against it).

export function installShutdown(deps: ShutdownDeps): void
```

Behavior — `installShutdown` registers the handler on `SIGTERM` and `SIGINT`
(via `process.once` per signal, so a second signal during shutdown is ignored);
a module-level `started` guard also makes the teardown itself idempotent. On the
first signal it:

1. **Stops the loops** — `deps.stopLoops()` (server.ts's closure `clearTimeout`s
   the currently-pending poll + sweep handles, so they stop rescheduling).
2. **Sheds idlers, drains in-flight** — `server.closeIdleConnections?.()` (drop
   keep-alive sockets with no active request now), then `server.close(cb)` (stop
   accepting new connections; the callback fires once all remaining connections
   end).
3. **Clean exit in the callback** — `repo.close()` then `exit(0)`.
4. **Force SSE closed after the drain window** — after `DRAIN_MS` (5000),
   `server.closeAllConnections?.()`. Long-lived SSE streams never end on their
   own, so without this `server.close`'s callback would never fire. Forcing them
   closed lets the callback run → clean exit. SSE clients reconnect on their own
   (`EventSource` auto-reconnect + the existing `Last-Event-ID` replay), so a
   forced close is safe.
5. **Hard backstop** — an `exit(1)` scheduled at `DRAIN_MS + 2000`, `.unref()`'d
   so it never itself keeps the process alive, in case `server.close`'s callback
   never fires (e.g. a socket wedged past `closeAllConnections`).

`exit` is called **at most once** (a `done` flag guards it), so the backstop is
a no-op after a clean `exit(0)`. In production `process.exit` terminates on the
first call anyway; the guard is what makes the "backstop only if not already
exited" behavior assertable in the test, where `exit` is a spy that doesn't
terminate.

Injecting only `exit` (plus `vi.useFakeTimers()` for the `DRAIN_MS` timing) is
what makes step-by-step assertions possible in the test without terminating the
runner — no other seam is needed.

### 2. `Repository.close()` (`core/src/storage/sqlite.ts`)

Add a `close(): void` method to the SQLite repository and the `Repository`
interface:

```ts
close(): void {
  this.raw.pragma('wal_checkpoint(TRUNCATE)')
  this.raw.close()
}
```

Checkpoints the WAL back into the main DB file (so a backup taken right after a
clean stop is self-contained) and closes the better-sqlite3 handle. `server.ts`
already reaches `repo.raw` for auth, but shutdown goes through this named method
so the DB-lifecycle boundary stays owned by the repository.

### 3. `core/src/server.ts` wiring

Minimal, mechanical changes:

- Capture the server handle: `const server = serve({ fetch: app.fetch, port: config.port })`.
- Hold the two loop timer handles instead of discarding them: the current
  `setTimeout(loop, …)` / `setTimeout(sweepLoop, …)` become
  `let pollTimer = setTimeout(loop, …)` (reassigned inside `loop`) and
  `let sweepTimer = setTimeout(sweepLoop, …)` (reassigned inside `sweepLoop`), so
  the handles passed to `installShutdown` are always the currently-pending ones.
- After `serve(...)`: `installShutdown({ server, repo, stopLoops: () => { clearTimeout(pollTimer); clearTimeout(sweepTimer) } })`.
  The `stopLoops` closure reads the *currently-pending* handles at shutdown time
  (the loops reassign `pollTimer`/`sweepTimer` on every reschedule), so there's no
  stale-snapshot problem and no need for `installShutdown` to know about timers at
  all — it just calls `stopLoops()`. `console.log` is called directly inside
  `shutdown.ts` (same as the loops), not injected.

### 4. SP2 web API tests (`web/src/lib/api.test.ts`)

Append tests mirroring the existing `createPost`/`addRemoteUser` style (a fake
`fetch` capturing URL/method/headers, asserting request shape + error handling):

- **`listAdminFeeds`** — calls `GET /admin/feeds`; returns the `.feeds` array
  from the JSON body; throws with the core error message on a non-ok response.
- **`removeRemoteFeed`** — calls `DELETE /users/:handle`; verifies the handle is
  `encodeURIComponent`-escaped (test with a handle needing it, e.g. `a b`);
  throws with the core error message on a non-ok response.

## Error handling

- Shutdown is idempotent: a repeat signal or a re-entrant call is a no-op (the
  `started` guard). Every teardown step is best-effort — the optional
  `closeIdleConnections`/`closeAllConnections` are called with `?.()` so a
  server object lacking them (a test fake, a future adapter) doesn't throw.
- `repo.close()` runs inside `server.close`'s callback; if the callback never
  fires, the `DRAIN_MS + 2000` backstop exits `1` (non-clean, but bounded — the
  container restarts).
- The API test additions assert the existing `errorMessage` failure path; no new
  runtime error handling in `api.ts` (the functions already throw on non-ok).

## Testing

**Core (`core/test/shutdown.test.ts`, vitest, existing in-process style):**
- On signal: `stopLoops` is called; `server.closeIdleConnections`
  and `server.close` are called; in `server.close`'s callback `repo.close()` then
  `exit(0)` are called (order asserted).
- With `vi.useFakeTimers()`: `server.closeAllConnections` fires at `DRAIN_MS` (5000);
  the `exit(1)` backstop fires at `DRAIN_MS + 2000` only if the close callback hasn't
  run.
- Idempotence: invoking the handler twice runs the teardown once.
- Fakes for `server`/`repo`/`exit` + a `stopLoops` spy; no real `process.exit`, no real signals
  (call the registered handler directly, or register on a throwaway emitter).

**Web (`web/src/lib/api.test.ts`):** `listAdminFeeds` + `removeRemoteFeed` happy
path (request shape + parsed result) and error path (throws core message), fake
`fetch`, no network — matching the file's existing tests.

## Out of scope

- The other still-open sweep items (`cloudScheme` 443-heuristic, XFF format
  validation, `purgeExpiredSubscriptions` push-subs sweep, rssCloud challenge
  expiry, unknown-handle 404, 4.09 GB image slim) — documented residuals or
  separate concerns, not this batch.
- Draining *WebSub/rssCloud* push work on shutdown — the poll loop is stopped;
  any in-flight push is best-effort and self-heals on the next cycle after
  restart. No new coordination.

## Testing approach note

`server.ts` runs work at import time (top-level `serve`, loops), so it is not
imported by tests; the shutdown logic lives in `shutdown.ts` precisely so it is
importable and testable in isolation. `server.ts`'s own wiring is a thin,
review-checked call — consistent with how the rest of the bootstrap is verified.

## Revisions

**Rev 1 (2026-07-18)** — folded a ponytail over-engineering review of this spec
(3 cuts, all accepted; net ≈ −8 lines and one fewer DI seam). All target the
`ShutdownDeps` shape, none touch a safety property:
- **`timers` union → `stopLoops: () => void`.** Only the getter form was ever
  wired; the `NodeJS.Timeout[] | (() => …)` union + "normalize inside" branch had
  no caller. `installShutdown` no longer knows about timers — it calls
  `deps.stopLoops()`, a closure `server.ts` already needs.
- **`drainMs?` → hardcoded `DRAIN_MS = 5000`.** No operator knob is planned for
  this batch (unlike `pollSeconds`/`anonTtlDays`); the test uses
  `vi.useFakeTimers()` against the constant for identical coverage.
- **Dropped `log?`.** No test asserts on log output and none in the repo spy on
  `console.log`; `shutdown.ts` calls `console.log` directly like the loops do.

`ShutdownDeps` is now 4 fields (`server`, `repo`, `stopLoops`, `exit`); `exit` is
the sole injected seam, justified because a test must never call the real
`process.exit`. Explicitly kept (real safety, per the review's own scope note):
the `DRAIN_MS + 2000` hard backstop, `Repository.close()`'s `wal_checkpoint(TRUNCATE)`,
the `started`/`done` double-guard, and `closeIdleConnections?.()` before `close`.
