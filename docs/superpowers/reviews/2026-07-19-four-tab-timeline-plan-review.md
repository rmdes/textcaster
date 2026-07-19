# SP2 four-tab timeline — plan review (rev 0 → rev 1)

Plan: `docs/superpowers/plans/2026-07-19-four-tab-timeline.md`
Reviewers: clean-context correctness (source-verified, two runnable probes) +
ponytail (over-engineering). All findings folded as plan rev 1; one spec
correction folded as spec rev 3.

## Correctness findings

1. **Important — Task 1 harness typing fails the typecheck gate.**
   `makeAuth` takes `SqliteRepository` (concrete class, needs `.raw`), but the
   fixture declared `let repo: Repository` (interface) → TS2345, verified by
   probe. Runtime green, typecheck red — exactly the trap the plan warns
   about. **Folded:** fixture typed `SqliteRepository` (same import as
   auth-helper), unused `Repository` import deleted.
2. **Important — spec rev-2 thread-fetch coverage had no task step.** The
   shared mapper can't catch a select list that forgot `u_feed_type`; a missed
   `getThread`/`listRepliesByPostId` select would fail no test. **Folded:**
   Task 1 gains a `repo.getThread(webfeedPostId)` assertion (second select
   site; also restores the webfeed-feedType assert after the ponytail cut).
3. **Important — deletePost redirect deviation.** Spec rev 2 said the tab
   redirect covers `compose`/`deletePost`; deletePost has never redirected
   (returns `{ removed: true }`) and needs no redirect — the action URL alone
   preserves the tab (no-JS re-render lands on the POSTed URL; enhanced
   submits don't navigate). **Folded:** spec rev 3 corrects the sentence; the
   plan states the invariant in Task 4's Interfaces.
4. Minor — amending the three existing `page.load.test.ts` tests (adding
   `parent`) is required, not scope drift. **Folded:** noted in Task 4 Step 1.
5. Minor — README task is plan-added scope (spec has no docs section).
   Accepted as repo practice; kept.
6. Minor — `f as never` vs the api.test.ts standing style
   `as unknown as typeof fetch`. **Folded.**

Verified-correct highlights (evidence in the reviewer's probes): Kysely 0.29.3
accepts `eb('col','in', eb.selectFrom(...))` inside `eb.or([...])` (ran against
real SQLite — result exactly `[webfeed, local]` with the stale instance
excluded); SvelteKit resolves the action as the first query param starting
with `/` (`?tab=local&/compose` works); `Redirect` carries `{status, location}`
own-properties; `await parent()` returns layout `{ me }`; `toEqual` ignores
undefined-valued keys; ComposerDialog takes arbitrary `action` strings; web
dev server is `127.0.0.1:5173`; all cited tokens exist in `app.css`.

## Ponytail findings (all folded)

1. Repo-level feedType test deleted — the HTTP test exercises the same mapper;
   webfeed coverage moved to the unfiltered HTTP fetch + getThread assert.
2. `fetch.mock.calls[0]` ordering coupling dropped — `calls.some(...)`
   matchers; the production "tests assert calls[0]" comment deleted.
3. `/peers` mock branches deleted from the new load tests — `getPeers` is
   catch-guarded and the default JSON parses harmlessly (matches existing
   tests).
4. Invalid-tab compose test folded into the main compose test.
5. `resolveTab` pass-through asserts trimmed to the two distinct branches.
6. `TAB_LINKS` const deleted — `{#each TABS}` + `text-transform: capitalize`.
7. Tasks 3+4 (lens/types + tabs/api) merged into one web-plumbing task —
   plan is now **6 tasks**.

Net: ~40 plan/test lines cut; three execution-blocking errors fixed before any
implementer hit them.
