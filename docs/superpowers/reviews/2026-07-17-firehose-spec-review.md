# Spec review — all-users RSS firehose (2026-07-17, 2e44bf6)

Grounded in reads of `feed.ts`, `service.ts`, `sqlite.ts`, `push.ts`,
`ingest.ts`. Ponytail + correctness; interop-format judgment on the three
flagged decisions.

**Verdict: strong spec, ready to plan after two items.** All three flagged
decisions are sound — and two are better-founded than the spec states, because
the existing code already supports them. Two things need pinning before the
plan: push-out is more than "learn a topic" (F-1), and the firehose needs a new
repository query that doesn't exist yet (F-2).

## The three flagged decisions — all sound

### 1. guid divergence (keep UUID guids, `isPermaLink="false"`, permalink in `<link>`) — CORRECT, and required

Per-user items already emit `guid: { value: p.guid, isPermaLink: false }`
(`feed.ts:82,133`) with UUID guids and `link` only when `url !== null`
(`:83,134`). The firehose reuses this mapping, so "guid in firehose == guid in
per-user feed" is automatic. Beyond interop caution, keeping UUID guids is
**required for correctness**: `findPostByRef` (`sqlite.ts:223`) resolves a
reply-ref against a `url` arm **then** a `guid` arm — changing guid values would
break the `byGuid` arm for refs other instances already resolved. Endorsed; the
"we know Dave does it differently" call is the right one.

### 2. local posts gain a permalink `url` at creation — additive and safe

Verified the whole chain already supports it: item mapping emits `<link>` on
non-null `url` (`feed.ts:83,134`); `createLocalPostAs` stores the reply ref as
`replyTo.url ?? replyTo.guid` (`service.ts:44`), so a reply to a *new* local
post references the permalink automatically; and `findPostByRef`'s `url` arm
(`sqlite.ts:225`) resolves that permalink ref. The consequence — new posts'
replies reference permalinks while old posts' (url still null) reference UUID
guids — is a **coexisting mix that both arms resolve**, no migration. Confirmed
the money test round-trips through exactly this. One note: this change is
logically independent of the firehose (it alters per-user feeds too); sequencing
it first (step 1) is fine since the firehose needs it to carry links.

### 3. `source:account` injector sibling — faithful, and write-only interop

`injectSourceComments` (`feed.ts:102-118`) is exactly the extensible,
guid-keyed string injector with idempotent `xmlns:source` bookkeeping and its
own `ponytail:` delete-when-feedsmith-supports comment. A `source:account`
sibling with the same shape is faithful; the two injectors are order-independent
(each adds xmlns only if absent). **F-3 (clarify):** `source:account` is
*outbound-only* interop — our ingest attributes from `<source url>`
(`ingest.ts:56` → `sourceName`/`sourceFeedUrl`), never from `sourceNs.account`,
and the money test correctly asserts the former. Make that explicit so no one
adds phantom `source:account` consumption to "complete" the round trip.

## New findings

- **F-1 — MED (design): push-out is real work, not a one-line topic addition.**
  `resolveLocalTopic` (`push.ts:37`) matches only
  `/users/<handle>/feed.(xml|json)` and returns a **user-shaped**
  `{ user, format }`; it has three callers — the existence check (`:84`), the
  rssCloud `format` check (`:112`), and the notify path that renders *that user's*
  feed. The firehose topic `/users/rss.xml` has **no user** and renders the
  all-users feed. So "resolveLocalTopic learns the firehose topic alongside
  per-user topics" understates it: the return contract must become a
  discriminated union (`{kind:'user',…} | {kind:'firehose',…}`) or gain a sibling
  resolver, and all three callers + the feed-render-on-notify branch must handle
  the userless case. Scope it as real work with tests, like the SSE-transform
  finding on the rich-content milestone.

- **F-2 — LOW (enumerate): the "recent N local posts" query does not exist.**
  The firehose wants the newest N posts across **all local authors**.
  `getPostsByAuthor` is single-author; `getTimeline`'s filter is
  `{ followedBy?, authorId? }` — no source/kind filter (contract-verified). A new
  repository method (e.g. `getRecentLocalPosts(limit)` or a `local`-only filter
  on `getTimeline`) is needed. Enumerate it in the plan (contract-tested like the
  rest) so it isn't discovered mid-build.

- **Ponytail (minor, no change needed):** comments + account injectors are two
  sequential full-XML string scans. Acceptable — it matches the existing
  per-concern injection pattern, and a combined single pass is available only if
  the injector ever gets hot. Leave as siblings.

## Verified sound
- Routing: `/users/rss.xml` (2 segments) cannot collide with
  `/users/:handle/feed.xml` (3 segments); `/users/rss/feed.xml` still binds
  `:handle=rss`. Test is correct.
- N read from the existing `FEED_LIMIT` (`app.ts:173`), not a new constant — as
  the spec instructs.
- Round trip: `<source url>` → feedsmith item `source:{title,url}` → `ingestItems`
  per-item `sourceName`/`sourceFeedUrl` is the proven rss.chat consumption path;
  ingesting the firehose as one remote user preserves per-item attribution
  exactly as it does for Dave's firehose today.
- Remote content is never re-broadcast (local-only) — correct on etiquette + SEC.

## What to change before planning
Scope push-out around `resolveLocalTopic`'s user-centric contract (F-1) and
enumerate the recent-local-posts query (F-2); note `source:account` as
write-only (F-3). The guid/permalink decisions, the injector sibling, the
routing, and the round-trip design are all sound. The feedsmith
channel-`source:self` / item-`source` / dropped-`source:account` behaviors are
"probed 2026-07-17" author claims — the plan re-probes them against the installed
feedsmith (do not code from memory), same discipline as prior milestones.
