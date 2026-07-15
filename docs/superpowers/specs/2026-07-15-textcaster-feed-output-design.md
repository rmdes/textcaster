# Textcaster milestone 1 — feed output + WebSub/rssCloud push-out

Date: 2026-07-15
Status: design approved (brainstorm); implementation not started
Author: Ricardo (rmdes) with Claude Code
Basis: design spec `docs/superpowers/specs/2026-07-15-textcaster-design.md`
(deferred item 1); main at `94bf81a` (spine + debt batch + feedsmith).

## What this is

The milestone where the federation loop closes: every local user's posts are
emitted as standard feeds, so another Textcaster instance can ingest them as
a remote user — two instances federate over plain RSS with zero extra
protocol. Plus the publish side of real-time, all opt-in and off by
default: WebSub (external hub or self-hosted hub, operator's choice) and
rssCloud (operator toggle).

Decisions taken at design time:

- **Scope**: feed output + push-OUT only. Push-in (WebSub subscriber,
  rssCloud notification receiving) is the next spec, where it can test
  against our own hub.
- **Formats**: RSS 2.0 + JSON Feed 1.1 per user, via feedsmith's
  `generateRssFeed`/`generateJsonFeed`. No Atom output.
- **Hub strategy**: operator-selectable, **push is opt-in** (spec-review
  H1): default = `off` — plain feeds, no third-party contact, and existing
  deployments upgrade without any config change. Operators set an external
  hub URL (e.g. `https://websubhub.com/hub`) or `self` (core runs a
  spec-compliant WebSub hub) to enable push.
- **rssCloud**: supported as publish-side, env-toggled, default off. There
  is no "external hub" variant — rssCloud's publisher IS the notification
  server, so enabling it always means core hosts the endpoint.
- **Approach A**: one push subsystem, one `subscriptions` registry shared by
  the self-hosted WebSub hub and rssCloud, with two thin protocol adapters
  for delivery. External-hub mode bypasses the registry entirely.

## 1. Feed output (core-only; web untouched)

Two public, unauthenticated routes on core:

- `GET /users/:handle/feed.xml` — RSS 2.0, `content-type:
  application/rss+xml; charset=utf-8`
- `GET /users/:handle/feed.json` — JSON Feed 1.1, `content-type:
  application/feed+json; charset=utf-8`

Semantics:

- Handle is looked up after the existing normalization (lowercase). Unknown
  handle → 404 JSON error.
- **Remote user's handle → 302 redirect to their canonical `feedUrl`** —
  pass-through per the Textcasting profile; we never republish someone
  else's feed as ours. **302, not 301, deliberately**: `feedUrl` is mutable,
  a permanent redirect would let caches pin a stale target (H8). A remote
  user whose `feedUrl` is null (type allows it) → 404.
- Local user → newest **50** posts by display order, via a new Repository
  method `getPostsByAuthor(authorId: string, limit: number):
  Promise<Post[]>` (ordered `published_at DESC, id DESC`, same ordering as
  the timeline; contract-pinned).

One shared mapper (`domain/feed.ts`) turns `(user, posts, config)` into the
feedsmith input shapes. Textcasting profile rules, binding:

- Item `title` present **only when `post.title` is non-null** — title-less
  items are legal RSS and the profile's namesake feature. Never synthesize a
  title from content.
- Full `content` in RSS `description` / JSON Feed `content_text` — no
  truncation.
- `guid` = `post.guid` (RSS `isPermaLink="false"`), JSON Feed `id` =
  `post.guid`.
- `link`/`url` only when `post.url` is non-null.
- `pubDate`/`date_published` = `post.publishedAt` (ISO in; feedsmith
  renders RFC-822 for RSS — probed).
- Channel/feed level: title = displayName; **channel description is
  unconditional** (feedsmith requires it): `Posts by <displayName>`; home
  link from `TEXTCASTER_PUBLIC_URL` when set.

Feedsmith 2.9.6 facts the implementation is written against (probed,
spec-review H6): `generateJsonFeed` returns an **object** — the route and
tests must `JSON.stringify` it; `generateRssFeed` **omits** an empty-string
`registerProcedure` attribute from `<cloud>` (harmless for `http-post` —
the spec text "registerProcedure omitted" is the expected output); channel
`description` is required at the type level (fallback above).

Discovery links: `rel="self"` (the feed's own absolute URL) and, when WebSub
is enabled, `rel="hub"` — RSS via `atom:link` elements, JSON Feed via
`feed_url` + `hubs: [{ type: 'WebSub', url }]`. When rssCloud is on, the RSS
feed (only) carries the `<cloud>` element. When `TEXTCASTER_PUBLIC_URL` is
unset, self/hub/cloud links are omitted and feeds still render.

**Round-trip test principle**: feed output correctness is asserted by
parsing our own generated feeds back through the existing `parseFeed` and
checking guid/title/content/url/date survive — the exact code path another
Textcaster instance would run.

## 2. Config

- `TEXTCASTER_PUBLIC_URL` — the instance's public origin (e.g.
  `https://cast.example.com`), used to mint absolute topic/self URLs. Must
  parse as an http(s) URL when set (same rule as feedUrl); trailing slash
  normalized away. Optional for plain feeds (links omitted); **required at
  startup (fail-fast, same style as the token check) whenever any push mode
  is explicitly enabled.**
- `TEXTCASTER_WEBSUB` = `off` | `self` | `<hub URL>`. **Default `off`**
  (H1: push is opt-in; upgrades need no config change and no third party is
  contacted by default). Any value that is not `off`/`self` must parse as an
  http(s) URL (fail-fast otherwise).
- `TEXTCASTER_RSSCLOUD` = `on` | `off`. Default `off`. Any other value
  fails fast.

## 3. Push subsystem (approach A)

### Storage — migration 2

The first real schema upgrade (and it earns the 1→2 upgrade-path test the
debt-batch final review requested):

```sql
CREATE TABLE subscriptions (
  id text PRIMARY KEY,             -- randomUUID(), cosmetic; identity is the UNIQUE triple
  protocol text NOT NULL,          -- 'websub' | 'rsscloud'
  topic text NOT NULL,             -- absolute feed URL
  callback text NOT NULL,          -- subscriber's delivery URL
  callback_host text NOT NULL,     -- derived at insert; serves the per-host cap
  secret text,                     -- websub only, nullable
  expires_at text NOT NULL,        -- ISO
  created_at text NOT NULL,
  UNIQUE (protocol, topic, callback)
)
```

Repository additions (contract-pinned, adapter-neutral):

- `upsertSubscription(s: Subscription): Promise<void>` — insert or refresh
  (same protocol+topic+callback replaces secret/expiry/callback_host).
  **Explicit conflict target with DO UPDATE** — the posts-table bare
  `doNothing()` pattern cannot be copied here (its own comment says why).
- `deleteSubscription(protocol, topic, callback): Promise<void>`
- `listActiveSubscriptions(topic: string, now: string):
  Promise<Subscription[]>` — `expires_at > now`, both protocols.
- `countActiveSubscriptions(filter: { callbackHost?: string; topic?: string },
  now: string): Promise<number>` — serves both caps below.
- `purgeExpiredSubscriptions(now: string): Promise<void>` — housekeeping,
  called opportunistically from the existing poller loop (which ticks even
  with zero remote users — verified).

### Registration hardening (H2 — these endpoints cannot be authed, so the
mitigations are structural; all three adopted)

1. **Challenge-verify every registration** — including no-domain rssCloud,
   where the protocol convention says "no challenge": we send the challenge
   GET anyway (benign deviation; a plain re-serving subscriber echoes
   nothing and is rejected, a compliant one passes). No registration is
   ever stored without a passed challenge.
2. **Private-range callback rejection**: at registration, resolve the
   callback host (`node:dns` lookup for hostnames; literal IPs checked
   directly) and reject loopback, link-local, RFC-1918/ULA ranges, and
   `localhost` — stdlib only. Accepted residual (ledgered): DNS rebinding
   between registration and delivery is not re-checked at delivery time.
3. **Caps** (constants): max **20** active subscriptions per
   `callback_host`, max **500** per topic. Registration beyond a cap → 4xx.
   These are structural anti-amplification bounds, NOT rate limiting (which
   remains a non-goal).

### Event wiring

`domain/push.ts` exposes `createPush(repo, config, feedRenderer, fetchFn)`
returning `{ onLocalPost(entry): Promise<void> }`, wired in `server.ts` as
`bus.onNewPost((e) => { void push.onLocalPost(e) })` — only acting when
`entry.source === 'local'` (remote posts never change our feeds).

**Seam contract (H4): `onLocalPost` NEVER rejects.** Bus callbacks run
synchronously inside `EventEmitter.emit` and `server.ts` has no global
rejection handler, so an unhandled rejection here is process-fatal. The
method's whole body sits in a top-level try/catch that logs (same
convention as `pollAll`); the existing 10s fetch timeout applies to every
outbound call. `ponytail:` known ceiling — N rapid posts trigger N feed
regenerations × M subscriber deliveries with no coalescing; debounce per
topic when it matters.

**Topic rule (H3): exact string equality.** A topic is valid iff it equals
one of the two minted URLs of an existing local user —
`PUBLIC_URL + '/users/' + handle + '/feed.xml'` or `'/feed.json'` (handle
already normalized, PUBLIC_URL already slash-normalized). No URL
normalization, no prefix matching; anything else → 4xx.

**Delivery matrix** (which protocol covers which topics per local-post
event):

| Topic                 | WebSub (self mode)     | rssCloud (on)   |
|-----------------------|------------------------|-----------------|
| `…/feed.xml`          | fat ping (RSS body)    | thin ping       |
| `…/feed.json`         | fat ping (JSON body)   | — (RSS-only)    |

The fat-ping body is regenerated **once per topic per event** and the same
body goes to every subscriber of that topic (also makes the HMAC assertions
deterministic in tests). External-hub mode publishes a ping for both
topics.

### Mode: external hub (when a hub URL is configured)

Per topic, form-POST to the configured hub:
`hub.mode=publish&hub.topic=<topic>&hub.url=<topic>` (`hub.url` kept for
hub compatibility, per websubhub.com's documented behavior). Fire-and-forget
with timeout + log. No registry involvement.

### Mode: self-hosted WebSub hub

- `POST /hub` (form-encoded, public): `hub.mode=subscribe|unsubscribe`,
  `hub.topic`, `hub.callback`, optional `hub.lease_seconds` (default 10
  days, capped at 30 days), optional `hub.secret` (<200 bytes).
  - Topic validity per the H3 equality rule; callback must be http(s) and
    pass the H2 hardening gates (private-range rejection, caps).
  - Respond `202 Accepted`, then verify per spec: GET
    `<callback>?hub.mode=…&hub.topic=…&hub.challenge=<challenge>` with
    `hub.lease_seconds` **included for subscribe and omitted for
    unsubscribe** (H7). Challenge = `randomBytes(16).toString('hex')`.
    Subscriber must echo the challenge with 2xx → store (upsert) or delete.
    Failed verification → no state change, logged.
- Delivery (fat ping) on topic update: regenerate the topic's feed body,
  POST it to each active callback with the feed's content-type, `Link`
  headers (`rel=self`, `rel=hub`), and `X-Hub-Signature:
  sha256=<HMAC-SHA256(secret, body)>` when the subscription has a secret.
- Best-effort delivery: per-subscriber timeout, ONE immediate retry, then
  drop. `ponytail:` known ceiling — no durable retry queue until real
  subscribers justify one.

### Mode: rssCloud (additive toggle)

- RSS feeds gain
  `<cloud domain=<public host> port=<public port> path="/rsscloud/pleaseNotify"
  registerProcedure="" protocol="http-post"/>`.
- `POST /rsscloud/pleaseNotify` (form-encoded, public): `notifyProcedure`,
  `port`, `path`, `protocol` (only `http-post` accepted; anything else →
  4xx), `url1` (the topic; must be one of our RSS feed URLs), optional
  `domain`.
  - Callback host = `domain` when supplied, else the requester's IP.
    **Every registration is challenge-verified (H2 rule 1)** — GET the
    callback with `url=<topic>&challenge=<random hex>`; the response body
    must contain the challenge. This deliberately deviates from the
    no-domain convention ("no challenge"): a compliant subscriber passes, a
    coerced third-party server does not. All H2 gates apply (private-range
    rejection, caps).
  - Registration stored in the same table, `protocol='rsscloud'`, fixed
    expiry **25 hours**; subscribers re-register daily (their job).
- Notification (thin ping) on topic update: form-POST `url=<topic>` to the
  callback. Subscriber re-fetches the feed. Same best-effort policy.

## 4. The money test (end-to-end federation loop)

One test, two in-process instances: instance A (repo+bus+service+app) has
local user alice with posts; instance B ingests
`http://a.example/users/alice/feed.xml` as a remote user through the
existing `ingestRemoteUser`, with a `fetchFn` stub that routes the URL to
A's `app.request`. Assert alice's post appears in B's timeline as a
`remote` post with guid/title/content intact — federation over plain RSS,
no extra protocol. This test is the milestone's definition of done.

## Non-goals

- Push-IN: WebSub subscribing to remote feeds, rssCloud notification
  receiving — next spec.
- Durable delivery queue / redelivery beyond one retry.
- Feeds for remote users beyond the 302 pass-through redirect.
- Atom output, OPML output, whole-instance firehose feed.
- Web-app changes of any kind (no profile pages, no link tags — no web
  surface exists for them yet).
- Rate limiting on the new public endpoints (spine-stage; the H2 caps are
  structural anti-amplification bounds, not rate limiting).

Accepted-with-ledger (decisions, not omissions):

- **Plaintext `secret` storage** in the subscriptions table — acceptable at
  this grade (the secret only authenticates our pushes to that subscriber);
  hash/encrypt when accounts/real auth land. Severity: low.
- **DNS rebinding residual** — private-range resolution is checked at
  registration only, not re-checked at delivery. Severity: low at spine
  scale; revisit alongside the ingestion-side private-IP blocking deferred
  since the spine (#7's "real auth milestone" note).

## Testing approach

TDD throughout:

- Contract suite: `getPostsByAuthor` ordering/limit; subscription
  upsert/refresh, active-vs-expired filtering, delete, purge.
- Feed routes: RSS + JSON round-trip through `parseFeed` (guid/title-less
  item/content/url/date survive) **plus raw-string assertions on the
  generated bodies** (H5 — the round-trip alone is feedsmith validating
  feedsmith): `<guid isPermaLink="false">`, `<atom:link` with `rel="hub"`,
  `<cloud `, `"version": "https://jsonfeed.org/version/1.1"`. Also: 404
  unknown; 302 remote (and 404 for a null-feedUrl remote); self/hub/cloud
  links present or omitted per config.
- Config: mode parsing, fail-fast rules (push without PUBLIC_URL; bad
  values).
- Self hub: subscribe happy path (challenge echoed → stored), failed
  challenge → not stored, unsubscribe (verification GET carries NO
  lease_seconds — H7), non-our-topic rejected (equality rule: a
  trailing-slash or case variant of a real topic is rejected), lease cap,
  delivery POST carries body + signature (verify HMAC in test), expired
  subscription not delivered, delivery failure retries once then drops
  without throwing.
- H2 hardening: loopback/private/localhost callbacks rejected at
  registration (both protocols); per-host and per-topic caps enforced.
- rssCloud: registration (http-post only), no-domain path IS
  challenge-verified (the benign deviation), domain-challenge path, thin
  ping shape, 25h expiry.
- Seam: `onLocalPost` with a throwing repo/fetch resolves without rejecting
  (H4 — the process-fatal path).
- External mode: publish ping fired per topic on local post (fake fetch),
  never on remote ingest.
- Migration: fresh DB → version 2; **version-1 DB upgrades in place to 2**
  (posts/users data preserved); fail-fast cases unchanged.
- End-to-end: the two-instance loop test (§4).

## Sequencing

1. Config additions (modes, PUBLIC_URL, fail-fast rules).
2. Migration 2 + subscription repository methods + contract pins +
   1→2 upgrade test.
3. `getPostsByAuthor` + feed mapper + the two routes (+ round-trip tests,
   302/404).
4. Push module: external-hub publish ping (smallest mode first).
5. Self-hosted hub: subscribe/verify/unsubscribe, then delivery.
6. rssCloud: cloud element, registration endpoint, thin ping.
7. Two-instance federation loop test + RUNNING.md (new env vars, hub modes).
