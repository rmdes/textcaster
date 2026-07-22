# RSC Logical Items and Ordinary Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the disabled-by-default Vertical 2 logical-item acquisition,
reconciliation, ordinary-read, feed, Web, and durable SSE path without dual
writing or exposing Vertical 3 evidence-review behavior.

**Architecture:** Extend the Vertical 1 source registry with an additive
logical-v2 schema. Network acquisition commits immutable observations and
durable jobs; a fenced worker reconciles each version into logical identity,
presentation, ancestry, and journal effects. One snapshot projector serves API,
feeds, Web SSR, and SSE while local posts remain authoritative through a
one-to-one bridge.

**Tech Stack:** Node 22 native TypeScript, Hono, better-sqlite3/Kysely,
feedsmith, Vitest, SvelteKit 2, Svelte 5.

**Revision:** 1 — initial task decomposition from the approved Vertical 2 spec.

**Status:** Ready for repository plan review; no implementation is authorized.

## Global Constraints

- Governing spec: `docs/superpowers/specs/2026-07-22-rsc-logical-items-ordinary-reads-design.md` rev 4.
- Prerequisite: Vertical 1 plan rev 4 has been implemented and reviewed.
- Companion dependency: `docs/superpowers/plans/2026-07-22-root-only-timelines.md` is executed as the first Vertical 2 slice; do not duplicate or weaken it here.
- `RSC_SOURCE_MODEL_V2` remains startup-immutable and defaults off. No dual writes, legacy remote conversion, v2 push, origin verification, moderation, purge, evidence-review API, or policy fan-out.
- V2 startup fails closed until schema, activation barrier, projector, journal, scheduler, reconciliation worker, and orphan worker are ready.
- Core stores and returns semantic content; Web alone renders HTML through `web/src/lib/server/render.ts`. Never add another sanitizer path.
- Use one SQLite write transaction for every domain mutation and its journal effects. Notifications happen after commit and contain sequence hints only.
- No TypeScript parameter properties in `core/src`; no new dependency without a separate approved design.
- Core route tasks must invoke `.claude/skills/hono/SKILL.md`. Web tasks must invoke the repository UI/Svelte skills and follow `design-system/rsc/MASTER.md`.
- Stage explicit paths only. Every commit ends with `developed with the help of AI tools`.
- This plan may be implemented only after all four vertical plans and the final cross-vertical review pass.

## File map and shared interfaces

Create focused modules rather than growing `sqlite.ts`, `service.ts`, or
`app.ts` into a second implementation:

```text
core/src/logical/types.ts             exact spec DTOs and internal records
core/src/logical/schema.ts            additive migration SQL and activation v1
core/src/logical/store.ts             bounded transactional reads/writes
core/src/logical/journal.ts           epoch, cursor, append, replay, pruning
core/src/logical/projector.ts         pure effective selection and DTO projection
core/src/logical/acquisition.ts       fenced fetch, redirects, parsing, observations
core/src/logical/scheduler.ts         four-slot polling and health/backoff
core/src/logical/reconcile.ts         single fenced reconciliation worker
core/src/logical/threading.ts         parent resolution, adoption, bounded projection
core/src/logical/runtime.ts           startup activation and worker composition
core/src/api/logical-routes.ts        v2 ordinary/admin routes and stream
web/src/lib/logical-types.ts          browser-safe mirror of v2 wire contracts
web/src/lib/logical-api.ts            capability-checked v2 Core client
web/src/lib/logical-live.ts           upsert/remove/reset reconciliation
```

`core/src/logical/types.ts` exports the spec names verbatim:
`LogicalItemDto`, `SelectedAuthor`, `ReplyContextDto`, `EnclosureDto`,
`LogicalSingleItemEnvelope`, `LogicalThreadEnvelope`, `LogicalHistoryEnvelope`,
`TimelineLens`, `LogicalTimelineEnvelope`, `JournalCursor`,
`AdminRunProjection`, `AdminRefreshResult`, and `AdminAcquisitionRun`.

The storage boundary is:

```ts
export interface LogicalStore {
  activateV2(now: string): void
  markV2ReconciliationRequired(): void
  snapshot<T>(read: (tx: LogicalReadTx) => T): T
  claimAcquisition(input: ClaimAcquisitionInput): ClaimAcquisitionResult
  commitAcquisition(input: CommitAcquisitionInput): AcquisitionRun
  claimReconciliation(now: string): ReconciliationClaim | null
  reconcileClaim(input: ReconcileClaimInput): ReconcileResult
  recordReconciliationFailure(input: RecordJobFailureInput): void
  appendOrphanWork(input: NewOrphanWork): void
  claimOrphanWork(now: string): OrphanClaim | null
  adoptOrphans(input: AdoptOrphansInput): AdoptOrphansResult
}
```

Every task below adds its exact method types to this interface before consumers
use them.

---

### Task 1: Execute the root-only companion slice

**Files:** The exact files and tests listed in
`docs/superpowers/plans/2026-07-22-root-only-timelines.md`.

**Interfaces:** Produces the reviewed v1 `topLevel` timeline behavior and compact
reply-count UI. Vertical 2 later replaces its transient SSE count enrichment
with durable logical journal effects.

- [ ] **Step 1:** Execute that reviewed plan task-by-task with its required TDD and review gates.
- [ ] **Step 2:** Run `npm test -w core && npm run typecheck -w core && npm test -w web && npm run check -w web && npm run build -w web`; expect all commands to exit 0.
- [ ] **Step 3:** Record the companion plan's final reviewed commit in this plan's execution notes. Do not rewrite its historical tasks.

### Task 2: Logical contracts, additive schema, and activation marker

**Files:** Create `core/src/logical/types.ts`, `core/src/logical/schema.ts`,
`core/src/logical/store.ts`, `core/test/logical-schema.test.ts`; modify
`core/src/storage/sqlite.ts`, `core/src/server.ts`.

**Interfaces:** Produces all shared wire types, `LogicalStore`, schema version 1,
and activation state `never_activated | active | reconciliation_required`.

- [ ] **Step 1: Write red schema/activation tests.** Assert every Section 7.1 table/index exists; first activation creates epoch/reset/active atomically; continuous restart preserves epoch and timestamps; a disabled boot marks reconciliation required.
- [ ] **Step 2: Run red tests.** Run `npm test -w core -- logical-schema`; expect missing module/tables failures.
- [ ] **Step 3: Add exact contracts and migration.** Copy Rev 4 DTO discriminants and bounds verbatim. Add publishers/names, logical items/local bridge/deleted marker, keys, deliveries/versions/seen metadata, presentation, claims/conflicts, parent/orphan work, acquisition/health/validators/redirects, jobs, journal, and activation metadata. Put schema SQL in `schema.ts`; `sqlite.ts` invokes one final transactional migration.
- [ ] **Step 4: Implement the pre-listen activation transaction.** Use `BEGIN IMMEDIATE`; reconcile local IDs and deletion state, initialize epoch if needed, append one reset, set `schemaVersion: 1` and timestamps, then commit before workers/listening.
- [ ] **Step 5: Run green tests and commit.** Run `npm test -w core -- logical-schema && npm run typecheck -w core`; expect PASS. Commit the five explicit paths plus `sqlite.ts`/`server.ts`.

### Task 3: Journal primitives and opaque cursor

**Files:** Create `core/src/logical/journal.ts`, `core/test/logical-journal.test.ts`;
modify `core/src/logical/store.ts`.

**Interfaces:** Produces `encodeJournalCursor`, `decodeJournalCursor`,
`appendJournal`, `readJournalBatch`, `pruneJournal`, and snapshot cursor reads.

- [ ] **Step 1:** Add red tests for epoch-qualified opaque cursors, strict sequence growth, 10,000-row retention, floor equality, below-floor/future/wrong-epoch invalidity, atomic prune/floor advancement, reconstruction epoch change, and reset rows.
- [ ] **Step 2:** Run `npm test -w core -- logical-journal`; expect FAIL.
- [ ] **Step 3:** Implement cursor version 1 and transactional append/prune. Journal rows contain only sequence, kind, nullable logical ID, bounded change mask, and timestamp.
- [ ] **Step 4:** Run `npm test -w core -- logical-journal && npm run typecheck -w core`; expect PASS, then commit explicit files.

### Task 4: Local-origin bridge and atomic local mutations

**Files:** Create `core/src/logical/local.ts`, `core/test/logical-local.test.ts`;
modify `core/src/domain/service.ts`, `core/src/storage/sqlite.ts`,
`core/src/logical/store.ts`.

**Interfaces:** Produces `projectLocalPost`, `materializeLocalBridge`, and
transactional create/edit/reply/delete/account-delete commands.

- [ ] **Step 1:** Add red tests for read-without-write synthesis, `logicalId === post.id`, restrictive unique local origin, atomic mutation+journal, remote echo protection, permanent deleted marker, descendant placeholder edge, one account reset, and no tombstone FK to deleted account.
- [ ] **Step 2:** Run `npm test -w core -- logical-local`; expect FAIL.
- [ ] **Step 3:** Move v2-on local mutations behind store transactions while leaving the v1 branch byte-for-byte semantic equivalent. Emit after-commit wake hints and retain outbound local-feed push notifications.
- [ ] **Step 4:** Run focused service/delete/edit/thread tests plus typecheck; expect PASS, then commit.

### Task 5: Bounded acquisition, redirects, observations, and refresh command

**Files:** Create `core/src/logical/acquisition.ts`,
`core/test/logical-acquisition.test.ts`, `core/test/logical-bounds.test.ts`;
modify `core/src/domain/ingest.ts`, `core/src/domain/push-guard.ts`,
`core/src/logical/store.ts`.

**Interfaces:** Produces `acquireSource(sourceId, reason, fence, signal)`, adapter
candidate records, canonical fingerprint v1, and atomic run/observation/job commit.

- [ ] **Step 1:** Add red fixture tests for the total 10-second deadline, streaming 5 MiB decoded cap, five redirects, loop/hop SSRF/governance/ownership checks, permanent-chain aliases, effective-URL validators, 1,000 candidates, 1 MiB item evidence, 32 enclosures, operational string limits, redacted digest evidence, and inert push discovery.
- [ ] **Step 2:** Add red identity tests for exact opaque IDs, normalized permalinks, fallback keys, complete first-arrival tuple, unchanged seen metadata, same-key multi-version jobs, and fingerprint-collision skip.
- [ ] **Step 3:** Run `npm test -w core -- logical-acquisition logical-bounds`; expect FAIL.
- [ ] **Step 4:** Implement streaming fetch/parsers and the two fenced transactions. Never call push endpoints and never partially parse an oversized body.
- [ ] **Step 5:** Run focused tests and typecheck; expect PASS, then commit.

### Task 6: Four-slot scheduler and operational administration

**Files:** Create `core/src/logical/scheduler.ts`,
`core/test/logical-scheduler.test.ts`, `core/test/logical-admin-api.test.ts`;
create `core/src/api/logical-routes.ts`; modify `core/src/api/app.ts`,
`core/src/server.ts`.

**Interfaces:** Produces scheduler `start/stop/wake`, refresh command ledger
association, run status/history/jobs, and source acquisition summary.

- [ ] **Step 1:** Add red scheduler tests for four slots, `(nextPollAt,sourceId)`, reasons at claim/commit, same-run higher-fence recovery, manual join, later run during old reconciliation, completion-based polling, shared backoff, pause/block invalidation, and startup without catch-up burst.
- [ ] **Step 2:** Add Hono route tests for exact neutral 404, 409 fingerprint conflict, created/joined/replayed disposition, zero-job terminal response, five-second 200/202, immutable pagination tuples, admin-only matrix, and secret/fence redaction.
- [ ] **Step 3:** Run `npm test -w core -- logical-scheduler logical-admin-api`; expect FAIL.
- [ ] **Step 4:** Implement scheduler and routes using Vertical 1 authorization/ledger patterns. Do not add evidence-review endpoints.
- [ ] **Step 5:** Run focused tests and typecheck; expect PASS, then commit.

### Task 7: Reconciliation, convergence, publishers, and presentation chains

**Files:** Create `core/src/logical/reconcile.ts`,
`core/src/logical/projector.ts`, `core/test/logical-reconcile.test.ts`,
`core/test/logical-presentation.test.ts`; modify `core/src/logical/store.ts`.

**Interfaces:** Produces the single 60-second fenced worker, pure selection
comparators, logical convergence, publisher names, and accepted presentation.

- [ ] **Step 1:** Add red worker tests for one-at-a-time claims, 16-row window, eight operational failures, 5s exponential retry, lost fence, supersession, separate failure bookkeeping, version serialization, and immutable terminal runs.
- [ ] **Step 2:** Add red domain tests for exact convergence keys, local-first lookup, isolated conflicts, mode-neutral claims, four evidence levels, current strongest-level stability, complete arrival/lexical ties, publisher naming normalization/ranking/reset, and per-delivery watermark/rollback/arrival fallback.
- [ ] **Step 3:** Run `npm test -w core -- logical-reconcile logical-presentation`; expect FAIL.
- [ ] **Step 4:** Implement one bounded transaction per job; all logical effects, hints, journal records, job state, and counters commit together. Reads remain authority and never repair hints.
- [ ] **Step 5:** Run focused tests and typecheck; expect PASS, then commit.

### Task 8: Resolve-once ancestry, orphan worker, and bounded threads

**Files:** Create `core/src/logical/threading.ts`,
`core/test/logical-threading.test.ts`; modify `core/src/logical/store.ts`.

**Interfaces:** Produces initial parent resolution, durable adoption, cycle/depth
proof, `projectThread`, and `LogicalThreadEnvelope`.

- [ ] **Step 1:** Add red tests for none/missing/ambiguous/resolved, no global opaque lookup, initial-version ordering, restrictive edge FK, missing-to-ambiguous terminal failures, candidate high water, 500-node subtree proof, depth 64, reset-only adoption, and deleted target exclusion.
- [ ] **Step 2:** Add projection tests for reserved root-to-request path, 500 structural nodes, independent truncation flags, structural-before-policy loading, placeholders, unavailable leaf 404, sibling ordering, and snapshot journal cursor.
- [ ] **Step 3:** Run `npm test -w core -- logical-threading`; expect FAIL.
- [ ] **Step 4:** Implement the continuous orphan worker and bounded recursive queries; roots are derived only.
- [ ] **Step 5:** Run focused tests and typecheck; expect PASS, then commit.

### Task 9: Ordinary projector, lenses, item/history routes, and feeds

**Files:** Create `core/test/logical-projector.test.ts`,
`core/test/logical-routes.test.ts`, `core/test/logical-feeds.test.ts`; modify
`core/src/logical/projector.ts`, `core/src/api/logical-routes.ts`,
`core/src/api/app.ts`, `core/src/domain/feed.ts`.

**Interfaces:** Produces `/timeline`, `GET /post/:id`, thread, revisions, and
existing feed branches returning exact model-v2 envelopes.

- [ ] **Step 1:** Add red projector tests using stale hints for exact DTO bounds, local echo classification, root-only river filters before LIMIT, activity author/publisher replies, Personal support, Federated any-approved support, immutable ordering/cursors, counts, and deterministic selection.
- [ ] **Step 2:** Add route tests for strict selector parsing, exact invalid lens/cursor responses, single-item 200/404, snapshot cursors, history selected-chain rules, and v1/v2 branch rejection.
- [ ] **Step 3:** Add feed tests: firehose local replies, local-author replies, direct-only comments, no publisher feed, no placeholders, and central policy projection.
- [ ] **Step 4:** Run the three focused suites; expect FAIL. Implement batched snapshot reads and routes without ordinary writes.
- [ ] **Step 5:** Run focused tests, existing feed/thread/timeline tests, and typecheck; expect PASS, then commit.

### Task 10: Source/profile transitions and durable reply invalidation

**Files:** Create `core/test/logical-policy-events.test.ts`; modify Vertical 1
source command module, `core/src/domain/service.ts`, `core/src/logical/store.ts`.

**Interfaces:** Produces exact generation/reset rules and deduplicated reply,
parent, and root journal effects.

- [ ] **Step 1:** Add red tests for governance/federation/mode generation+reset, pause/resume no reset, subscription/follow/profile reset rules, no-op/replay, publisher label reset, bounded reply parent/root upserts, content-edit no count effect, and reset-only adoption/account/source-wide changes.
- [ ] **Step 2:** Run `npm test -w core -- logical-policy-events`; expect FAIL.
- [ ] **Step 3:** Insert journal append calls inside the existing Vertical 1/local transactions; never append after commit or perform fan-out.
- [ ] **Step 4:** Run focused source/service tests and typecheck; expect PASS, then commit.

### Task 11: Durable SSE protocol and runtime isolation

**Files:** Create `core/test/logical-sse.test.ts`,
`core/test/logical-runtime.test.ts`; modify `core/src/api/logical-routes.ts`,
`core/src/logical/runtime.ts`, `core/src/server.ts`, `core/src/domain/bus.ts`.

**Interfaces:** Produces epoch-qualified SSE `upsert | remove | reset`, buffered
sequence hints, heartbeat catch-up, and v1/v2 startup isolation.

- [ ] **Step 1:** Add red SSE tests for query-to-header cursor seed, missing/invalid reset-close, stored/synthesized reset IDs, floor overrun, listener-before-replay, coalesced hints, heartbeat comments, send-time projection, and no placeholder events.
- [ ] **Step 2:** Add runtime tests proving disabled v2 starts only legacy poll/push, enabled v2 installs neither, activation precedes listening/workers, all workers gate readiness, and local after-commit hints still support outbound feed push.
- [ ] **Step 3:** Run `npm test -w core -- logical-sse logical-runtime`; expect FAIL.
- [ ] **Step 4:** Implement journal-driven stream and explicit runtime composition. The bus never supplies SSE content authority.
- [ ] **Step 5:** Run focused and legacy SSE/push tests plus typecheck; expect PASS, then commit.

### Task 12: Capability-aware Web DTOs, pages, feeds, and live reconciliation

**Files:** Create `web/src/lib/logical-types.ts`, `web/src/lib/logical-api.ts`,
`web/src/lib/logical-live.ts`, `web/src/lib/logical-api.test.ts`,
`web/src/lib/logical-live.test.ts`, `web/src/routes/p/[publisherId]/+page.server.ts`,
`web/src/routes/p/[publisherId]/+page.svelte`; modify timeline, local-author,
following, post, history, thread proxy, feed proxy, and stream proxy files.

**Interfaces:** Consumes exact v2 envelopes; produces capability/model validation,
shared semantic rendering, publisher page, and sorted live upsert/remove/reset.

- [ ] **Step 1:** Add red API tests for discriminated capabilities, exact envelope validation, single item, lenses, malformed fail-closed, and v1 isolation.
- [ ] **Step 2:** Add red live/proxy tests for opaque cursor forwarding/header precedence, upsert-only rendering, remove/reset passthrough, malformed close/revalidate, reset SSR reconnect, immutable insertion, river reply exclusion, and parent/root authoritative counts.
- [ ] **Step 3:** Add page tests for both feature states, publisher 404/empty descriptor, local `/u`, root-only rivers, activity replies, thread placeholders, history sanitizer, and no publisher follow.
- [ ] **Step 4:** Run `npm test -w web`; expect focused failures. Implement capability branches without casting between models.
- [ ] **Step 5:** Run `npm test -w web && npm run check -w web && npm run build -w web`; expect PASS, then commit explicit Web files.

### Task 13: Operational admin Web and whole-vertical gate

**Files:** Create `web/src/routes/admin/sources/[sourceId]/runs/+page.server.ts`,
`web/src/routes/admin/sources/[sourceId]/runs/+page.svelte`, relevant tests;
modify the Vertical 1 source-detail page and `web/src/lib/logical-api.ts`;
create `core/test/logical-vertical.test.ts`.

**Interfaces:** Produces refresh/run/job UI only and proves the complete default-off
Vertical 2 boundary.

- [ ] **Step 1:** Add admin Web tests for command ID retention, neutral refusal, 200 terminal versus success, 202 polling, health/nonterminal runs, pagination, quarantined labeling, and absence of evidence-review links.
- [ ] **Step 2:** Add integration tests for first activation, continuous restart, disabled interval/reactivation, scheduler-to-observation-to-job-to-projection-to-journal, crash fences, local/remote convergence, and every cross-model isolation rule.
- [ ] **Step 3:** Run focused tests; expect FAIL. Implement only the run/status
  functions in `web/src/lib/logical-api.ts`, the two run page files, the
  source-detail refresh action/status panel, and the runtime wiring exercised by
  `core/test/logical-vertical.test.ts`.
- [ ] **Step 4:** Run the completion gate: `npm test -w core`, `npm run typecheck -w core`, `npm test -w web`, `npm run check -w web`, and `npm run build -w web`; expect all exit 0.
- [ ] **Step 5:** Run `git diff --check`, stage explicit paths, commit with the required footer, and stop for Vertical 2 implementation review. Do not enable v2 by default or begin Vertical 3.
