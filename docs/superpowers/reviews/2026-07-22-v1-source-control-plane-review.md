# Vertical 1 — Source Control Plane: plan review

**Date:** 2026-07-22
**Reviews:** `plans/2026-07-20-rsc-source-control-plane.md` (rev 4) against
`specs/2026-07-20-rsc-source-governance-moderation-design.md` (rev 3) and the
current `core/` + `web/` code.
**Method:** three parallel clean-context reviewers (contract-fidelity /
Hono-house-style, flag-off regression safety, ponytail over-engineering),
de-duplicated and severity-ranked here, adjudicated against a direct read of
the plan's ledger + auth sections. Findings are line-referenced to the plan;
**verify each against the actual files when folding** (clean-context reviewers
can misread a line number).

**Overall:** faithful, well-typed, correctly-scoped plan. The domain core
(source/publisher/subscription separation, command ledger, governance axes,
federation, audit) is load-bearing foundation, not bloat, and V1 does **not**
leak into V2/V3/V4 (no logical items, no reconciliation, no hide/restore, no
purge, no migration). Two classes of real issue: (A) an OFF-state **web
regression risk** on the live 3 instances, and (B) a cluster of **under-specified
contracts** (auth-matrix status, idempotency fingerprints, transition matrix,
bodyLimit) that should be closed before implementation. None require redesign.

Spec-pointer check: plan rev 4 governs design **rev 3**, and the design file is
rev 3 — consistent, no [[plan-spec-pointer-sync]] drift.

---

## Blockers / High

### 1. [HIGH] Web branch inserts a serial `GET /capabilities` fetch *ahead* of the live timeline/subscribe path — OFF-state read regression
Plan L815–817, L899–907, L874–875 (Task 8). Today `web/.../+page.server.ts`
calls `getTimeline`/`getFollowing`/`getPeers` directly; only `getPeers` is
non-load-bearing. Task 8 makes every changed load/action first
`await getCapabilities(fetch)` to pick the branch — a call that is **serial and
precedes** the timeline fetch. Consequence with the flag OFF: the currently-
deployed web makes zero `/capabilities` calls; after this ships, the home
timeline and subscribe form gain a hard upstream dependency on a route that
does not exist on a not-yet-updated core pod. On a rolling deploy across the 3
instances, a web pod hitting an old core pod (or any transient `/capabilities`
blip) → `getCapabilities` throws → `coreDown` → home renders the "can't load"
alert even though `getTimeline` would have succeeded. That degradation is
impossible today.
**Fix:** fetch `/capabilities` in parallel with the existing timeline call, and
on capability-fetch failure fall back to the **legacy** path (which is what OFF
*is*) rather than to `coreDown` — degrade to today's behavior, never below it.
A `/capabilities` non-200 (or fetch throw) must **never be cached as sticky
state** by the web pod: memoize only a *successful* reading (Finding 8); a
failure falls back to legacy for that request and is retried next request, so a
transient blip can't pin a pod to a wrong branch for its lifetime. Add a
deploy-ordering note (Task 10 / RUNNING.md): `/capabilities` must be live on all
core instances before the new web is promoted.

### 2. [HIGH] The two existing web tests that would catch Finding 1 are omitted from Task 8's scope
Plan L864–872, L922 (Task 8 file list + git-add) exclude
`web/src/routes/page.load.test.ts` and `web/src/routes/page.actions.test.ts`,
which directly exercise the changed load/subscribe action and encode today's
behavior:
- `page.load.test.ts:40` asserts the **first** fetch is the timeline call
  (`calls[0]` contains `before=…`); a preceding `/capabilities` fetch breaks it.
- `page.load.test.ts:46–51` asserts an **exact** coreDown object shape.
- `page.actions.test.ts:85–87` (cap-error) mocks 429 for every fetch; an
  unconditional `getCapabilities` sees 429 → bails to coreDown before
  `subscribeToFeed`, so the 429 cap-error is never surfaced.
Task 8's OFF assertion (`toMatchObject({api:'legacy'})`, L887) only proves the
*branch chosen* is legacy — not that the load's observable output and
**call sequence** are byte-identical to today.
**Fix:** add both test files to Task 8's modify list; make the OFF-path
assertion "core call sequence and returned object unchanged from pre-change,"
not merely `api:'legacy'`. If OFF is truly zero-diff, the parallel-fetch impl
(Finding 1) lets these tests pass **unmodified** — the cleanest proof.

### 3. [HIGH/blocker] Admin authz matrix `[401,403,403,200,403,403]` is unsatisfiable under the mandated `sessionAuth`
Plan L785–792 (Task 7). The matrix maps actors
`[unauth, anon, registered, admin, validOps, invalidOps]`. New admin routes must
reuse the house `app.use('/admin/*', authed, requireAdmin())` composition
(`app.ts:164`). `authed = sessionAuth` calls `auth.api.getSession({headers})`; a
request carrying only `Authorization: Bearer <RSC_TOKEN>` has **no better-auth
session** → `getSession` returns null → `c.json({error:'authentication
required'}, 401)` (`auth.ts:64–66`), never reaching `requireAdmin`'s 403. So
validOps/invalidOps on admin routes yield **401, not 403**. The assertion is
wrong (security is unaffected — access is denied either way — but the test as
written cannot pass under house middleware).
**Fix:** set both ops columns to **401** for the admin routes. The ops token's
*only* authorized surface is `POST /ops/sources/federation`; it must not be
implied to reach a distinct 403 on `/admin/*` (design §11: ops token grants "no
administrative read"). Confirmed against `auth.ts` directly, not only the
reviewer's read.

---

## Important — under-specified contracts (close before implementing)

### 4. [IMPORTANT] Idempotency fingerprint undefined for 3 of the 5 mutating commands
Plan L437, L517 define the `requestFingerprint` for subscribe
(`[operation, normalizedUrl]`) and OPML (`["import-opml", boundedXml]`), but
**not** for `unsubscribe`, `establishFederation`, or `transition`. Design §11
(L560–561) requires "reusing an ID for a different command is rejected," which
is only enforceable if each command defines its fingerprint. Tasks 5/6 test
"identical retry returns stored result" but never a *changed* command under the
same ID, so the conflict branch is undefined for those three routes.
**Fix:** specify fingerprint inputs — unsubscribe `["unsubscribe", sourceId]`,
transition `[action, sourceId, attributionMode ?? '']`, establishFederation
`["federation", normalizedUrl, attributionMode]` — and add a changed-command →
conflict assertion to Tasks 5 and 6.

### 5. [IMPORTANT] Transition matrix advertised "complete" but several cells unspecified
Plan L640–641, L673–694 (Task 6). The success table tests `block` only from
`allowed`; the only named conflicts are "approve while blocked" and "allow
directly from blocked." Undefined: `block` from `quarantined` (a real
moderation-escalation need — design §5 says block applies "regardless of
operation" and doesn't restrict it to `allowed`), `quarantine`/`allow` from
`blocked` (should conflict — design L302: "the only source-governance exits are
explicit unblock or purge"), `reject`/`revoke` when federation is `none` (no
relationship to act on), and `pause`/`resume` while `blocked`.
**Fix:** enumerate the missing cells — explicitly **permit** `block` from
`quarantined`, **reject** `quarantine`/`allow` from `blocked`, and define
`reject`/`revoke`-on-`none` and `pause`/`resume`-while-`blocked`.

### 6. [IMPORTANT] New v2 JSON-write routes specified without `bodyLimit` (house rule)
Plan L815–846 (Task 7). The current code guards every JSON write
(`jsonWrite = bodyLimit({maxSize: MAX_JSON_BYTES})`, `app.ts:65` — added this
session) and every public/federation POST. The plan's new writers —
`POST /me/subscriptions`, `POST /admin/sources`, and especially the
externally-reachable token-authed `POST /ops/sources/federation` — state no
`bodyLimit`. The Hono skill lists body limits on public/federation POSTs as
house style.
**Fix:** state that each new v2 POST composes `jsonWrite` positionally (and the
ops route its own `bodyLimit`), matching `app.ts`. Reuse the existing helper —
`jsonWrite = bodyLimit({ maxSize: MAX_JSON_BYTES, onError: rejectOversized })`
at **`core/src/api/app.ts:65`** (`MAX_JSON_BYTES = 512 * 1024` at `:63`),
introduced by the Hono-audit fixes — do not reinvent. When folding this into the
rev, cite that file:line in the rev text (per house practice: a "reuse X"
instruction that names X's exact location is the pattern that has kept these
folds honest).

---

## Medium

### 7. [MEDIUM] Task 9 admin load has no capability-failure branch or test → silent-empty risk
Plan L940–966. `web/.../admin/feeds/+page.server.ts` today is
`return { feeds: await listAdminFeeds(f) }` with no try/catch (core-down →
error page). Task 9 covers `sourceModelV2:false`→legacy and `true`→v2 but has
**no `capability-error` case** (unlike Task 8). If the impl catches a
capability failure and returns `feeds:[]`, the admin page silently renders "no
feeds" instead of today's error page.
**Fix:** add a capability-error assertion pinning OFF/failure to today's
throw-to-error-page; state that admin load must not swallow a capability failure
into an empty list.

### 8. [MEDIUM] Capability value is process-constant but re-fetched every request
Plan L905. The flag is read once at startup (`Config.sourceModelV2`,
`config.ts`) and `/capabilities` projects that constant — no mid-process flip,
no half-on state within a process (good; the only skew window is cross-instance
deploy, Finding 1). But re-fetching it per changed load/action is a new HTTP
round-trip per home view for an immutable value.
**Fix:** memo-cache the capability result for the web process lifetime (safe
precisely because it's process-immutable); shrinks Finding 1's blast radius to
one call per web-pod lifetime. **Cache only a successful (200) reading** — never
memoize a non-200 or a fetch failure, or a transient blip during a rolling
deploy would pin the pod to the wrong branch until restart. A failed read falls
back to legacy for that request only (Finding 1) and is retried next request.

---

## Resolved decision — DEFER the forward-referenced surface (~150 lines)

The ponytail lens flags **~150 lines** of surface that V1 defines but no V1 code
produces; the fidelity lens judges the same surface "defensible expand-only
groundwork, not scope creep." Both readings are technically correct.
**Maintainer decision (2026-07-22): defer all of it.** Rationale: this
codebase's migration discipline is strictly append-only and additive, so the
deferred cost is one cheap later migration — while the *carried* cost is real
now: empty tables and always-null DTO fields are surface every future reviewer
must re-verify as "intentionally dead" (this very review shows how much reviewer
time dead-but-plausible surface consumes), and the ops-token route is an
**authz-bearing endpoint with no consumer** — authz surface with zero users is
pure risk. Defer each item to the vertical that first writes it:

- `source_aliases_v2` + `blocked_source_tombstones_v2` — **no V1 writer** (aliases
  need a transport redirect after a fetch; V1 performs no fetch — L407; tombstones
  need purge — deferred). Their `listSourceAliases`/`aliasCount` and the
  subscribe/federation tombstone-resolution branches query permanently-empty tables.
- `policy_generation` — incremented on every transition (L690) but **read by
  nothing** until V2 fan-out (L719–721). **Also defer** — with one caveat
  checked and cleared: it is not merely a dead column; it rides `RemoteSource`
  (L57) → `SourceTransitionResult` (L134) → serialized into
  `command_ledger_v2.result_json`, and appears in the admin DTO loop (L572) +
  redaction test (L1015). The keep-exception would be "omitting it forces a
  *ledger-format* migration." Verified it does **not**: the ledger stores
  `result_json` opaquely and replays it verbatim (L337, no schema enforced), so
  old rows replay their stored shape and V2 simply adds the field when fan-out
  first needs it — no persisted-format break. Deferring therefore also removes
  it from `RemoteSource`/`SourceTransitionResult`/the DTO loop + the two test
  refs (slightly wider than dropping a column, still cheap); V2 reintroduces it
  when its fan-out first reads it.
- `SourceSummary.push` / `.health` / `.itemCount` / `.deliveryCount` — hard-null
  or hard-zero in V1 (L314–316).
- `origin_verification` retention branch (L610) — guards a provenance V1 never
  creates (V3); its test must hand-seed the source to fire.
- `POST /ops/sources/federation` — a second caller of `establishFederation` the
  admin route already covers, dragging in `operator_token` actor kind + RSC_TOKEN
  fingerprint + the two ops columns of the authz matrix. No real ops integration
  exists yet to be "compatible" with.
- `AuditCategory` values `migration_review` / `false_positive` / `remediated` —
  no V1 emitter.

**Decision:** defer all of the above — the two empty tables, `policy_generation`
(per the caveat-cleared note above), the always-null DTO fields, the
`origin_verification` retention branch, the ops-token federation route, and the
three unused `AuditCategory` values — each to the vertical that first writes it.
The other tab folds this as removals from V1's Task 1 schema, the affected DTOs,
and the ops-API task, with a one-line "reintroduced in V<n>" pointer beside each
so the forward-reference is tracked, not lost.

---

## Minor (fold or note)

- **`subscribeByUrl` dispatch owner unspecified** (L377–379 vs L430–431): the
  interface method is declared but the raw-URL → (local-follow vs remote-source)
  dispatch and which layer owns `localHandleForUrl` (legacy does it inline,
  `app.ts:327`) is never stated.
- **Action enum drift** (L831 vs L645): route segment `:action=attribution-mode`
  (hyphen) vs domain `set_attribution_mode` (underscore); every other action is
  identical, so give the mapping or rename the segment.
- **Cap source** (L431): `resolveAndSubscribeSource(...cap...)` never says the cap
  reads `max_subs_per_user` (default 500, `service.ts:173`) — design §4 requires
  the v2 cap be the *same* limit as legacy.
- **Non-success status rows** (L820–832): `transition {kind:'unknown'}` and
  `unsubscribe {kind:'unknown'}` have no HTTP status (404?), and an
  illegal-transition `{kind:'conflict'}` collapses onto the same 409 as
  command-reuse conflict with no distinguishing body.
- **Block/unblock confirmation copy** (L968–972 vs design L554): design §10
  requires block/unblock/purge confirmations to "state their distinct
  consequences"; Task 9 only says "render explicit no-JS forms."
- **`pending_review` availability projection** (L101, L566–577): `active→available`
  and quarantined `pending→awaiting_review` are covered, but a `pending_review`
  sub (from aggregate conversion) has no defined `OwnerSourceFollow.availability`.

---

## Verified strong — do NOT churn these

- **Migration is safe**: the v2 SQL is pure `CREATE TABLE` + `CREATE INDEX`, no
  `ALTER` to any existing table; forward FKs only. Safe on a populated prod DB
  **provided the new entry is appended at the END of `MIGRATIONS`** (mid-array
  insertion would renumber and corrupt `user_version`).
- **Legacy core routes untouched when OFF**: no task edits the existing
  `POST /me/subscriptions`, `/me/follows`, `DELETE /me/follows/:target`,
  `POST /users`, `DELETE /users/:handle`, `GET /admin/feeds`, `GET /timeline`
  handlers; v2 is parallel, gated at registration. (ON-only note: v2 shares the
  `POST /me/subscriptions` / `GET /me/following` paths — verify v2 registration
  actually supersedes legacy when ON, since Hono first-match wins.)
- **Ledger serialization is correct**: `checkCommand`/`storeCommand` run inside
  the caller's `BEGIN IMMEDIATE`; cap-check + subscription insert share one
  transaction (design §4 satisfied). Verified directly (plan L327–337, L434–437).
- **DTO names consistent** across tasks and match `types.ts` verbatim; the
  seven-table schema test matches the seven `CREATE TABLE`s.
- **No V2/V3/V4 leakage**: `itemCount:0`, no reconciliation, no moderation, no
  purge, no migration code.

---

## Suggested fold order

Close Findings 1–3 before any implementation (they change task file-lists,
test assertions, and a status contract). Fold 4–6 into their task specs (pure
spec text). Decide the appetite call. Treat 7–8 and the Minors as fold-on-touch.
Re-review only Findings 1–3 after folding; the rest are self-evident once written.
