# RSC Source Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the disabled v2 source registry and let administrators and users exercise source resolution, subscriptions, and lifecycle management end to end without changing legacy ingestion.

**Revision:** 2 — folds in the first parallel plan review: general command
ledger, transactional repository commands, complete read DTOs, owner/public
subscription management, cleanup, and SSRF-gated resolution.

**Architecture:** Add expand-only v2 tables to the existing SQLite migration array and isolate their domain surface behind `SourceRepository` and `createSourceService`. `RSC_SOURCE_MODEL_V2` switches source/subscription/admin routes between legacy and v2 behavior; it defaults off and performs no dual writes. Core remains policy authority, while web provides no-JS forms over explicit stable-ID endpoints.

**Tech Stack:** Node 22 native TypeScript, Hono, Kysely/better-sqlite3, Vitest, SvelteKit/Svelte 5.

## Global Constraints

- Governing spec: `docs/superpowers/specs/2026-07-20-rsc-source-governance-moderation-design.md` rev 2.
- `RSC_SOURCE_MODEL_V2` accepts only `on | off` and defaults to `off`.
- No dual writes, rollout percentages, new dependencies, or remote-item migration in this vertical.
- URL normalization changes only scheme/host/default port and fragment; preserve path, query, trailing slash, and HTTP/HTTPS. Reject credentials and URLs longer than 2048 characters.
- Browsers talk only to web. Core returns semantic JSON, never rendered HTML.
- Core route work must use `.claude/skills/hono/SKILL.md`. Web implementation must use the available UI/Svelte skills and `design-system/rsc/MASTER.md`.
- No TypeScript parameter properties in `core/src`.
- Stage explicit paths only. Every commit message ends with `developed with the help of AI tools`.
- During implementation, use Docker verification when the stack is running; otherwise use the host commands from `AGENTS.md`.

---

### Task 1: Feature switch and source-control schema

**Files:**
- Modify: `core/src/config.ts`
- Modify: `core/src/domain/types.ts`
- Create: `core/src/domain/source-repository.ts`
- Modify: `core/src/storage/sqlite.ts`
- Modify: `core/test/config.test.ts`
- Create: `core/test/source-schema.test.ts`

**Interfaces:**
- Produces `Config.sourceModelV2: boolean`.
- Produces `SourceRepository`, `RemoteSource`, `FederationRelationship`,
  `SourceSubscription`, `SourceAuditEvent`, `CommandEnvelope`, the source read
  DTOs, and `BlockedSourceTombstone`.
- Adds expand-only tables; legacy tables and methods remain unchanged.

- [ ] **Step 1: Add failing config tests**

In `core/test/config.test.ts`, append:

```ts
test('RSC_SOURCE_MODEL_V2 defaults off and accepts only on/off', () => {
  const base = { RSC_TOKEN: 't', RSC_AUTH_SECRET: 's' }
  expect(loadConfig(base).sourceModelV2).toBe(false)
  expect(loadConfig({ ...base, RSC_SOURCE_MODEL_V2: 'on' }).sourceModelV2).toBe(true)
  expect(() => loadConfig({ ...base, RSC_SOURCE_MODEL_V2: 'yes' })).toThrow('RSC_SOURCE_MODEL_V2')
})
```

- [ ] **Step 2: Add failing schema tests**

Create `core/test/source-schema.test.ts` and assert the new tables and constraints through `repo.raw`:

```ts
test('v2 source-control tables exist with unique canonical identifiers', async () => {
  const repo = await createSqliteRepository(':memory:')
  const tables = repo.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  expect(tables.map((r) => r.name)).toEqual(expect.arrayContaining([
    'remote_sources_v2', 'source_aliases_v2', 'federation_relationships_v2',
    'source_subscriptions_v2', 'source_audit_v2', 'command_ledger_v2',
    'blocked_source_tombstones_v2',
  ]))
  repo.close()
})
```

Add a second test inserting duplicate `canonical_url`, duplicate alias URL, and duplicate `(owner_id, source_id)` and assert `SQLITE_CONSTRAINT_UNIQUE`.

- [ ] **Step 3: Run the focused tests and verify failure**

Run: `npm test -w core -- config source-schema`

Expected: config assertions fail because the field is absent; schema assertions fail because the tables do not exist.

- [ ] **Step 4: Define exact domain types and repository interface**

Add to `core/src/domain/types.ts`:

```ts
export type AttributionMode = 'single_publisher' | 'aggregate'
export type SourceOperation = 'enabled' | 'paused'
export type SourceGovernance = 'allowed' | 'quarantined' | 'blocked'
export type FederationStatus = 'pending' | 'approved'
export type SourceSubscriptionState = 'active' | 'pending' | 'pending_review'

export interface RemoteSource {
  id: string
  canonicalUrl: string
  attributionMode: AttributionMode
  operation: SourceOperation
  governance: SourceGovernance
  policyGeneration: number
  provenance: 'user_subscription' | 'opml' | 'admin_federation' | 'origin_verification' | 'migration'
  provenanceNote: string | null
  adminRetained: boolean
  createdAt: string
}
```

Add these exact interfaces:

```ts
export interface FederationRelationship {
  sourceId: string
  status: FederationStatus
  provenanceNote: string | null
  createdAt: string
  updatedAt: string
}

export interface SourceSubscription {
  id: string
  ownerId: string
  sourceId: string
  state: SourceSubscriptionState
  createdAt: string
}

export interface SourceAuditEvent {
  id: string
  sourceId: string
  commandId: string
  actorId: string | null
  actorKind: 'administrator' | 'system'
  action: string
  category: string | null
  note: string | null
  resultJson: string
  createdAt: string
}

export interface SourceAlias {
  url: string
  sourceId: string
  createdAt: string
}

export interface CommandEnvelope {
  actorScope: 'owner' | 'administrator' | 'ops' | 'system'
  actorId: string
  commandId: string
  requestFingerprint: string
}

export interface BlockedSourceTombstone {
  id: string
  canonicalUrl: string
  blockCategory: string
  blockActorId: string | null
  blockNote: string | null
  blockedAt: string
  purgeCategory: string
  purgeActorId: string | null
  purgeNote: string | null
  purgedAt: string
}

export interface SourceTransitionWrite {
  sourceId: string
  command: CommandEnvelope
  action: 'pause' | 'resume' | 'quarantine' | 'allow' | 'approve' | 'reject' | 'revoke' | 'block' | 'unblock' | 'set_attribution_mode'
  category: string | null
  note: string | null
  nextOperation?: SourceOperation
  nextGovernance?: SourceGovernance
  nextFederation?: FederationStatus | 'none'
  nextAttributionMode?: AttributionMode
  createdAt: string
}

export interface Page<T> { items: T[]; nextCursor: string | null }
export interface SourceSummary {
  source: RemoteSource
  federationStatus: 'none' | FederationStatus
  subscriptionCounts: { active: number; pending: number; pendingReview: number }
  itemCount: number
  deliveryCount: number
  push: { mode: PushProtocol | null; state: 'pending' | 'active' | 'expired' | 'invalid' | null; endpointFingerprint: string | null }
  health: { lastFetchAt: string | null; lastSuccessAt: string | null; lastFailure: string | null }
}
export interface SourceDetail extends SourceSummary {
  aliasCount: number
  latestAudit: SourceAuditEvent | null
}
export interface OwnerSourceSubscription {
  subscription: SourceSubscription
  source: Pick<RemoteSource, 'id' | 'canonicalUrl' | 'attributionMode' | 'operation' | 'governance'>
}
export interface OwnerFollowingView { localFollows: User[]; sourceSubscriptions: OwnerSourceSubscription[] }

export type SourceTransitionResult =
  | { kind: 'applied'; source: RemoteSource; audit: SourceAuditEvent }
  | { kind: 'conflict' | 'unknown' }
```

In `source-repository.ts`, define focused methods used in Tasks 2–3:

```ts
export interface SourceRepository {
  getSource(id: string): Promise<RemoteSource | undefined>
  followLocalAccount(input: FollowLocalAccountWrite): Promise<FollowLocalAccountResult>
  resolveAndSubscribeSource(input: ResolveAndSubscribeWrite): Promise<ResolveAndSubscribeResult>
  importSourceSubscriptions(input: ImportSourcesWrite): Promise<ImportSourcesResult>
  createFederationSource(input: CreateFederationSourceWrite): Promise<CreateFederationSourceResult>
  unsubscribeAndCleanupSource(input: UnsubscribeSourceWrite): Promise<UnsubscribeSourceResult>
  transitionSource(input: SourceTransitionWrite): Promise<SourceTransitionResult>
  listSourceSummaries(cursor: { createdAt: string; id: string } | undefined, limit: number): Promise<Page<SourceSummary>>
  getSourceDetail(id: string): Promise<SourceDetail | undefined>
  listOwnerFollowing(ownerId: string): Promise<OwnerFollowingView>
  listPublicFollowingSources(ownerId: string): Promise<RemoteSource[]>
  listSourceAliases(sourceId: string, cursor: { createdAt: string; url: string } | undefined, limit: number): Promise<Page<SourceAlias>>
  listSourceSubscriptions(sourceId: string, cursor: { createdAt: string; id: string } | undefined, limit: number): Promise<Page<SourceSubscription>>
  listSourceAudit(sourceId: string, cursor: { createdAt: string; id: string } | undefined, limit: number): Promise<Page<SourceAuditEvent>>
}
```

Define the command inputs/results in `source-repository.ts`:

```ts
export interface NewSourceDefaults { attributionMode: AttributionMode; governance: SourceGovernance; federation: 'none' | 'approved'; provenance: RemoteSource['provenance']; provenanceNote: string | null }
export interface FollowLocalAccountWrite { command: CommandEnvelope; ownerId: string; targetId: string; now: string }
export type FollowLocalAccountResult = { kind: 'followed' | 'exists'; target: User } | { kind: 'unknown' }
export interface ResolveAndSubscribeWrite { command: CommandEnvelope; ownerId: string; canonicalUrl: string; defaults: NewSourceDefaults; cap: number; now: string }
export type ResolveAndSubscribeResult = { kind: 'active' | 'pending'; source: RemoteSource; subscription: SourceSubscription } | { kind: 'unavailable' | 'not_subscribable' | 'cap' }
export interface ImportSourcesWrite {
  command: CommandEnvelope
  ownerId: string
  localTargetIds: string[]
  canonicalUrls: string[]
  unavailableCount: number
  cap: number
  now: string
}
export interface ImportSourcesResult {
  localFollowed: number
  active: number
  pending: number
  unavailable: number
  notSubscribable: number
  capSkipped: number
}
export interface CreateFederationSourceWrite { command: CommandEnvelope; canonicalUrl: string; attributionMode: AttributionMode; provenanceNote: string; now: string }
export type CreateFederationSourceResult = { kind: 'created'; source: RemoteSource; federation: FederationRelationship } | { kind: 'exists' | 'unavailable' | 'conflict' }
export interface UnsubscribeSourceWrite { command: CommandEnvelope; ownerId: string; sourceId: string; now: string }
export type UnsubscribeSourceResult = { kind: 'removed'; sourceRemoved: boolean } | { kind: 'unknown' | 'conflict' }
```

- [ ] **Step 5: Add the config field and expand-only migration**

Parse the flag beside other on/off settings. Add one final migration entry in
`core/src/storage/sqlite.ts` creating exactly this schema (use the repository's
existing UUID/text timestamp conventions and migration wrapper):

```sql
CREATE TABLE remote_sources_v2 (
  id TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL UNIQUE,
  attribution_mode TEXT NOT NULL CHECK (attribution_mode IN ('single_publisher','aggregate')),
  operation TEXT NOT NULL CHECK (operation IN ('enabled','paused')),
  governance TEXT NOT NULL CHECK (governance IN ('allowed','quarantined','blocked')),
  policy_generation INTEGER NOT NULL DEFAULT 0,
  provenance TEXT NOT NULL CHECK (provenance IN ('user_subscription','opml','admin_federation','origin_verification','migration')),
  provenance_note TEXT,
  admin_retained INTEGER NOT NULL DEFAULT 0 CHECK (admin_retained IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE TABLE source_aliases_v2 (
  url TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES remote_sources_v2(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE TABLE federation_relationships_v2 (
  source_id TEXT PRIMARY KEY REFERENCES remote_sources_v2(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','approved')),
  provenance_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE source_subscriptions_v2 (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES remote_sources_v2(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('active','pending','pending_review')),
  created_at TEXT NOT NULL,
  UNIQUE(owner_id, source_id)
);
CREATE TABLE source_audit_v2 (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES remote_sources_v2(id) ON DELETE CASCADE,
  command_id TEXT NOT NULL,
  actor_id TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('administrator','system')),
  action TEXT NOT NULL,
  category TEXT,
  note TEXT,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE command_ledger_v2 (
  actor_scope TEXT NOT NULL CHECK (actor_scope IN ('owner','administrator','ops','system')),
  actor_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor_scope, actor_id, command_id)
);
CREATE TABLE blocked_source_tombstones_v2 (
  id TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL UNIQUE,
  block_category TEXT NOT NULL,
  block_actor_id TEXT,
  block_note TEXT,
  blocked_at TEXT NOT NULL,
  purge_category TEXT NOT NULL,
  purge_actor_id TEXT,
  purge_note TEXT,
  purged_at TEXT NOT NULL
);
CREATE INDEX remote_sources_v2_page ON remote_sources_v2(created_at DESC, id DESC);
CREATE INDEX source_subscriptions_v2_owner_state ON source_subscriptions_v2(owner_id, state, source_id);
CREATE INDEX source_audit_v2_page ON source_audit_v2(source_id, created_at DESC, id DESC);
```

`command_ledger_v2` has primary key `(actor_scope, actor_id, command_id)` plus
`request_fingerprint`, `result_json`, and `created_at`. A repeated key with the
same fingerprint returns the stored result; a different fingerprint conflicts.

Do not add v2 item/delivery tables yet. Implement the read DTO mapping and six
repository commands. `importSourceSubscriptions` also inserts the supplied
`localTargetIds` into the existing local-follow table, so a mixed OPML import
has one ledger result and one transaction. Every command uses one `BEGIN
IMMEDIATE` transaction for
ledger lookup, URL/alias/tombstone resolution, source defaults, relationship or
subscription writes, audit, serialized result storage, and commit. Cap counting
includes `active`, `pending`, and `pending_review`.

`unsubscribeAndCleanupSource` deletes the subscription and, in that same
transaction, removes an allowed self-service source only when no subscription,
federation relationship, verification-evidence role, or `admin_retained` reason
remains. It creates no tombstone. Quarantined and blocked sources are retained.
This vertical has no v2 items, so later item cleanup is explicitly added to the
same command in Vertical 2 rather than performed out of transaction.

- [ ] **Step 6: Run focused tests and static checking**

Run: `npm test -w core -- config source-schema`

Expected: PASS.

Run: `npm run typecheck -w core`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add core/src/config.ts core/src/domain/types.ts core/src/domain/source-repository.ts core/src/storage/sqlite.ts core/test/config.test.ts core/test/source-schema.test.ts
git commit -m "core: add disabled v2 source-control schema

developed with the help of AI tools"
```

---

### Task 2: Canonical source resolution and source subscriptions

**Files:**
- Create: `core/src/domain/source-url.ts`
- Create: `core/src/domain/source-service.ts`
- Modify: `core/src/api/app.ts`
- Modify: `core/src/server.ts`
- Create: `core/test/source-service.test.ts`
- Modify: `core/test/subscriptions-api.test.ts`
- Modify: `core/test/opml.test.ts`
- Modify: `core/test/push-guard.test.ts`

**Interfaces:**
- Consumes `SourceRepository` from Task 1 and existing `localHandleForUrl`.
- Produces `normalizeSourceUrl(raw): string` and `createSourceService(repo, deps)`.
- Produces v2 results `active | pending | unavailable | not_subscribable | cap`.
- Every mutation accepts `commandId`; core computes a SHA-256 request fingerprint
  from actor scope/ID, operation, and validated canonical input.

- [ ] **Step 1: Write URL normalization and rejection tests**

Create `source-service.test.ts` with exact expectations:

```ts
expect(normalizeSourceUrl('HTTPS://Example.COM:443/feed/?x=1#frag')).toBe('https://example.com/feed/?x=1')
expect(normalizeSourceUrl('http://Example.COM:80/feed')).toBe('http://example.com/feed')
expect(normalizeSourceUrl('http://example.com/feed/')).toBe('http://example.com/feed/')
expect(() => normalizeSourceUrl('https://user:pass@example.com/feed')).toThrow('source URL invalid')
expect(() => normalizeSourceUrl('file:///tmp/feed')).toThrow('source URL invalid')
expect(() => normalizeSourceUrl(`https://example.com/${'x'.repeat(2049)}`)).toThrow('source URL invalid')
```

Add service tests proving new user sources use the exact defaults, an existing
paused source is reused unchanged, aliases resolve, aggregate/federation sources
return `not_subscribable`, quarantined creates `pending`, blocked/tombstone
returns `unavailable`, and two concurrent final-cap attempts yield one create
and one cap result.

Add SSRF-guard dependency tests proving canonical local feeds bypass
remote network validation, while URL subscription, every OPML remote URL, and
admin federation creation reject loopback, private, and link-local targets
before any v2 row is written. Redirect-hop checks remain in the fetch path and
are not simulated by source creation, which performs no network fetch.

Add retry tests for subscribe, unsubscribe, mixed local/remote OPML import, and
admin federation creation. Each retries the same command ID and body and sees
the byte-equivalent stored result; changing the URL, source ID, OPML entries,
attribution mode, or note under that command ID returns `conflict` and performs
no write.

- [ ] **Step 2: Add failing API/OPML tests**

Under v2-on app configuration, test:

- canonical local feed URL creates a local follow and zero v2 source rows;
- a remote URL returns active or neutral pending JSON;
- aggregate/federation returns the same neutral not-subscribable response;
- blocked/tombstone returns generic unavailable and creates nothing;
- unsubscribe removes pending normally;
- OPML uses identical local/source resolution and does not expose pending in
  public export.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `npm test -w core -- source-service subscriptions-api opml`

Expected: FAIL because v2 resolver/service and route branch do not exist.

- [ ] **Step 4: Implement the resolver and service**

`source-url.ts` owns the one normalizer. `source-service.ts` exposes:

```ts
export interface SourceService {
  subscribeByUrl(owner: User, url: string, commandId: string): Promise<{ kind: 'active' | 'pending'; source: RemoteSource } | { kind: 'local'; user: User; followed: boolean } | { kind: 'unavailable' | 'not_subscribable' | 'cap' }>
  importOpml(owner: User, xml: string, commandId: string): Promise<ImportSourcesResult>
  createFederation(input: { url: string; attributionMode: AttributionMode; provenanceNote: string; commandId: string; actorId: string }): Promise<CreateFederationSourceResult>
  unsubscribe(ownerId: string, sourceId: string, commandId: string): Promise<UnsubscribeSourceResult>
  ownerFollowing(ownerId: string): Promise<OwnerFollowingView>
  publicFollowing(ownerId: string): Promise<{ localFollows: User[]; sources: RemoteSource[] }>
}

export type CreateSourceService = (repo: SourceRepository, deps: {
  publicUrl: string | null
  getLocalByHandle(handle: string): Promise<User | undefined>
  getSubscriptionCap(ownerId: string): Promise<number>
  checkRemoteUrl(url: string): Promise<{ ok: true } | { ok: false; reason: string }>
}) => SourceService
```

Export `createSourceService` with this exact function type and implement each
method against the repository result and endpoint contracts below. Add this
helper and use it for every
mutating service call; pass canonical arrays/tuples rather than arbitrary
objects so property order cannot change the digest:

```ts
export function commandEnvelope(
  actorScope: CommandEnvelope['actorScope'],
  actorId: string,
  commandId: string,
  operation: string,
  canonicalInput: readonly unknown[],
): CommandEnvelope {
  return {
    actorScope,
    actorId,
    commandId,
    requestFingerprint: createHash('sha256')
      .update(JSON.stringify([operation, ...canonicalInput]))
      .digest('hex'),
  }
}
```

For OPML, the canonical input is the bounded original XML body; for all other
commands it is the normalized URL or stable source/target ID plus every field
that can affect the result. New URL sources are exactly
`single_publisher + enabled + allowed + federation none + user_subscription`;
new OPML sources differ only by `provenance = opml`. Admin federation creation
uses its supplied mode with `enabled + allowed + approved + admin_federation`.

Check canonical local feeds before remote validation and pass a local match to
`repo.followLocalAccount`, including its command envelope. For every other URL call
the injected existing SSRF guard before invoking a repository command. Normalize
and validate every OPML outline independently. Partition OPML entries into
canonical local target IDs, SSRF-approved canonical remote URLs, and an
`unavailableCount`; submit all three groups once through
`importSourceSubscriptions`. Unsafe entries do not abort safe entries, while
the complete normalized import remains one idempotent transaction. Preserve
every axis on reuse. New URL/OPML sources use Task 1 defaults. Only
non-federation single-publisher sources are subscribable.

- [ ] **Step 5: Wire the disabled route branch**

Pass `sourceModelV2` and `sourceService` through `server.ts` into `createApp`.
When off, current routes are byte-for-behavior unchanged. When on,
`POST /me/subscriptions`, stable-ID unsubscribe, owner/public following reads,
and OPML import/export call the v2
service. Do not write legacy remote users/follows in the v2 branch.

Endpoint contracts when v2 is on:

| Endpoint | Success |
|---|---|
| `POST /me/subscriptions` `{url,commandId}` | `201 {subscription:'active',source}` or `202 {subscription:'pending',message}` |
| `DELETE /me/subscriptions/:sourceId` `{commandId}` | `200 {removed:true,sourceRemoved}` |
| `POST /me/follows/opml` body + `x-rsc-command-id` | `200 ImportSourcesResult` |
| `GET /me/following` | owner local follows plus active/pending/pending_review sources |
| `GET /users/:handle/follows` | local follows plus active allowed sources only |
| `GET /users/:handle/following.opml` | local follows plus active allowed source URLs only |

Unavailable and not-subscribable both return `409 {error:'source unavailable'}`.
Cap returns 429. Reusing a command ID with a different fingerprint returns 409.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -w core -- source-service subscriptions-api opml`

Expected: PASS.

Run: `npm test -w core` and `npm run typecheck -w core`

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add core/src/domain/source-url.ts core/src/domain/source-service.ts core/src/api/app.ts core/src/server.ts core/test/source-service.test.ts core/test/subscriptions-api.test.ts core/test/opml.test.ts core/test/push-guard.test.ts
git commit -m "core: resolve v2 sources and subscriptions

developed with the help of AI tools"
```

---

### Task 3: Source lifecycle, federation creation, reads, audit, and command ledger

**Files:**
- Modify: `core/src/domain/source-service.ts`
- Modify: `core/src/api/app.ts`
- Create: `core/test/source-lifecycle.test.ts`
- Create: `core/test/source-admin-api.test.ts`

**Interfaces:**
- Produces stable-ID `/admin/sources` list/detail/create endpoints.
- Produces stable-ID pause/resume/quarantine/allow/approve/reject/revoke/block/unblock endpoints.
- Every command consumes `commandId`; retry returns the original result.
- Source creation, federation creation, subscription, unsubscribe, OPML, and
  lifecycle transitions all use `command_ledger_v2`.

- [ ] **Step 1: Write lifecycle matrix tests**

Build a table with one row for each action and the exact expected axes:

```ts
const cases = [
  ['pause',       'enabled', 'allowed',     'none',     'paused',  'allowed',     'none'],
  ['resume',      'paused',  'allowed',     'none',     'enabled', 'allowed',     'none'],
  ['quarantine',  'enabled', 'allowed',     'none',     'enabled', 'quarantined', 'none'],
  ['allow',       'enabled', 'quarantined', 'pending',  'enabled', 'allowed',     'pending'],
  ['approve',     'enabled', 'quarantined', 'pending',  'enabled', 'allowed',     'approved'],
  ['reject',      'enabled', 'quarantined', 'pending',  'enabled', 'quarantined', 'none'],
  ['revoke',      'enabled', 'allowed',     'approved', 'enabled', 'allowed',     'none'],
] as const
```

For each row, seed its initial source/relationship, execute once, and assert the
final axes, `policyGeneration + 1`, one audit row, and one ledger row. Retry the
same envelope and assert no counter changes. Separately assert: approve while
blocked conflicts; allow directly from blocked conflicts; unblock is the only
implemented governance exit from blocked in this vertical (purge is added with
retained items in Vertical 3); `single_publisher -> aggregate` moves
both active and ordinary pending subscriptions to `pending_review`; and
`quarantined -> allowed` activates ordinary pending but never `pending_review`.

- [ ] **Step 2: Write API authorization/redaction tests**

Drive every endpoint through this authorization matrix:

```ts
const actors = ['unauthenticated', 'anonymous', 'registered', 'admin', 'ops', 'bad-ops'] as const
const expected = {
  list:   [401, 403, 403, 200, 403, 403],
  detail: [401, 403, 403, 200, 403, 403],
  audit:  [401, 403, 403, 200, 403, 403],
  create: [401, 403, 403, 201, 200, 403],
  mutate: [401, 403, 403, 200, 403, 403],
} as const
```

Here `ops/create` is the explicitly scoped compatibility operation and still
calls `createFederationSource`; it cannot call list, detail, audit, moderation,
block, purge, or other lifecycle routes. Serialize every success and error and
assert it contains none of the seeded callback token, secret, Authorization
header, or ops token.

Test `POST /admin/sources` is atomic: canonical URL/tombstone resolution,
source defaults, approved federation row, audit, and command result all exist
or none do. Race two commands for the same URL and assert one created result
and one neutral exists result without duplicate relationships.

Test `listSourceSummaries`, `getSourceDetail`, alias pagination, subscriber
pagination, and audit pagination return the exact DTOs from Task 1. Seed equal
timestamps and assert the stable ID/URL tie-breaker prevents duplicates across
pages. Until later verticals, item/delivery counts are zero and push/health
values are null; the API must not invent legacy counts.

- [ ] **Step 3: Run and verify failure**

Run: `npm test -w core -- source-lifecycle source-admin-api`

Expected: FAIL because lifecycle methods and routes are absent.

- [ ] **Step 4: Implement transition methods**

Add this method to `SourceService` and implement it as one dispatcher using
`repo.transitionSource`:

```ts
transition(input: {
  sourceId: string
  action: SourceTransitionWrite['action']
  category: string | null
  note: string | null
  attributionMode?: AttributionMode
  commandId: string
  actorId: string
}): Promise<SourceTransitionResult>
```

Require category for governance/federation actions;
pause/resume category remains optional. Enforce the approved transition matrix,
monotonic `policyGeneration`, subscription state changes, and system/admin actor
rules in the same transaction as audit/idempotency result.

Do not add item fan-out or journal tables in this vertical because no v2 item
is publishable. Vertical 2 must add the journal/reset barrier in the same task
that makes the first v2 item accessible.

- [ ] **Step 5: Add explicit admin routes**

Add v2-on routes under `/admin/sources`, all addressed by source ID. Retire
nothing while the switch defaults off. Use stable cursor parsing for list,
limit 1–100, and summary-only JSON. Keep ops-token compatibility separate and
narrow.

Pin these contracts:

| Endpoint | Contract |
|---|---|
| `GET /admin/sources?before=&limit=` | `Page<SourceSummary>` |
| `GET /admin/sources/:id` | `SourceDetail` |
| `GET /admin/sources/:id/aliases?before=&limit=` | `Page<SourceAlias>` |
| `GET /admin/sources/:id/subscriptions?before=&limit=` | `Page<SourceSubscription>` |
| `GET /admin/sources/:id/audit?before=&limit=` | `Page<SourceAuditEvent>` |
| `POST /admin/sources` `{url,attributionMode,provenanceNote,commandId}` | `201` created (including identical retry), `409` exists/unavailable/conflict |
| `POST /admin/sources/:id/:action` `{commandId,category,note}` | `200 SourceTransitionResult`, `409` invalid/conflicting command |

`:action` is exactly pause, resume, quarantine, allow, approve, reject,
revoke, block, unblock, or attribution-mode. All route bodies use the shared
hand validator style; no raw URL appears after the creation endpoint resolves it.
Encode every `before` cursor as base64url JSON containing the displayed
`createdAt` and stable `id` (or alias `url`), order descending by that tuple,
fetch `limit + 1`, and return the last displayed tuple as `nextCursor`.

- [ ] **Step 6: Run full core verification**

Run: `npm test -w core` and `npm run typecheck -w core`

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add core/src/domain/source-service.ts core/src/api/app.ts core/test/source-lifecycle.test.ts core/test/source-admin-api.test.ts
git commit -m "core: add v2 source lifecycle and admin API

developed with the help of AI tools"
```

---

### Task 4: No-JS source administration and subscription states

**Files:**
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/routes/+page.server.ts`
- Modify: `web/src/routes/+page.svelte`
- Modify: `web/src/routes/admin/feeds/+page.server.ts`
- Modify: `web/src/routes/admin/feeds/+page.svelte`
- Create: `web/src/routes/admin/feeds/source-actions.test.ts`
- Modify: `web/src/routes/u/[handle]/following/+page.server.ts`
- Modify: `web/src/routes/u/[handle]/following/+page.svelte`
- Create: `web/src/routes/u/[handle]/following/following.actions.test.ts`
- Modify: `web/src/lib/api.test.ts`

**Interfaces:**
- Consumes Task 2 subscription results and Task 3 stable-ID admin endpoints.
- Produces SSR/no-JS source lists grouped by governance/federation state.
- Produces the owner/public following boundary and stable-ID unsubscribe action.

- [ ] **Step 1: Write failing API wrapper and action tests**

Test exact wrappers for paginated source list, create, and every lifecycle
action. Test that home subscription renders the neutral pending message,
not-subscribable/unavailable errors remain neutral, and pending never appears
in public-facing data.

Test admin action forms submit stable source ID plus server-generated
`commandId`, category, and optional note. Retry the same command ID and assert
the UI receives the original state without duplicate feedback.

In `following.actions.test.ts`, assert the owner sees local follows and source
subscriptions in `active`, `pending`, and `pending_review`; another viewer sees
only local follows and active subscriptions whose source is allowed. Submit an
unsubscribe form containing `sourceId` and a server-generated `commandId`, then
assert pending removal succeeds and the page no longer contains that stable ID.
Assert neither public profile counts nor public OPML include pending states.

- [ ] **Step 2: Run and verify failure**

Run: `npm test -w web -- api source-actions following.actions`

Expected: FAIL because wrappers and actions are absent.

- [ ] **Step 3: Implement wrappers and server actions**

Add semantic types and wrappers in `api.ts`; never expose secrets. Update the
home subscribe action to distinguish active/pending while preserving no-JS
redirect/flash behavior. Generate command IDs server-side with `crypto.randomUUID()`
and place them in hidden inputs rendered by the load/action result.

Update `u/[handle]/following` to choose `GET /me/following` only when the
authenticated viewer owns the profile; all other viewers use the public route.
Render source URL plus neutral state for the owner, and post source removals to
`DELETE /me/subscriptions/:sourceId`. Never address a mutation by URL or handle.

- [ ] **Step 4: Replace the flat feed admin view**

Keep the existing 42rem editorial layout and tokenized colors. Group sources
as approved federation, quarantine/pending, allowed user sources, and blocked.
Show mode, axes, canonical URL, safe push state, subscriber/item counts, and
latest health summary. Provide plain forms for applicable transitions; do not
add delivery/item evidence UI yet.

- [ ] **Step 5: Run web verification**

When containers run:

```bash
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm test -w web"
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm run check -w web"
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm run build -w web"
```

Otherwise run `npm test -w web`, `npm run check -w web`, and
`npm run build -w web`.

Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/types.ts web/src/routes/+page.server.ts web/src/routes/+page.svelte web/src/routes/admin/feeds/+page.server.ts web/src/routes/admin/feeds/+page.svelte web/src/routes/admin/feeds/source-actions.test.ts 'web/src/routes/u/[handle]/following/+page.server.ts' 'web/src/routes/u/[handle]/following/+page.svelte' 'web/src/routes/u/[handle]/following/following.actions.test.ts' web/src/lib/api.test.ts
git commit -m "web: manage v2 sources and pending subscriptions

developed with the help of AI tools"
```

---

### Task 5: Vertical integration gate and operator documentation

**Files:**
- Modify: `.env.example`
- Modify: `core/.env.example`
- Modify: `docs/superpowers/documentation/RUNNING.md`
- Create: `core/test/source-control-integration.test.ts`

**Interfaces:**
- Proves switch-off legacy behavior and switch-on v2 source-control behavior.
- Documents that v2 remains disabled until Vertical 4 migration.

- [ ] **Step 1: Write the integration test**

Create one HTTP-level test that subscribes a registered user to a new remote
URL, sees it in Personal subscription management, quarantines it as admin,
observes that its retained active subscription has no public exposure, allows
it, pauses/resumes it, and verifies
audit/idempotent retry. Run the same legacy subscription smoke test with v2 off
and assert the existing remote-user behavior remains unchanged.

- [ ] **Step 2: Run and verify failure**

Run: `npm test -w core -- source-control-integration`

Expected: FAIL until all v2 route wiring is complete.

- [ ] **Step 3: Document the switch**

Add `RSC_SOURCE_MODEL_V2=off` to both env examples. In RUNNING.md state that
`on` is development-only until the final migration plan, uses empty v2 tables,
and does not mirror legacy writes.

- [ ] **Step 4: Run the complete vertical gate**

Run core tests and typecheck plus web tests, check, and production build using
the commands in Global Constraints. Expected: all exit 0.

- [ ] **Step 5: Run the required review workflow**

Run `/ponytail-review` on the code diff. Then request a whole-vertical code
review before merging or starting Vertical 2. Fold all blocking findings into
a numbered revision of this plan's review record under
`docs/superpowers/reviews/`.

- [ ] **Step 6: Commit documentation and integration coverage**

```bash
git add .env.example core/.env.example docs/superpowers/documentation/RUNNING.md core/test/source-control-integration.test.ts
git commit -m "docs: gate the v2 source control plane

developed with the help of AI tools"
```
