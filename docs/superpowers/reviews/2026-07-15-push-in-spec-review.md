# Spec review — push-in (ponytail lens + adversarial), pre-implementation

Date: 2026-07-15
Target: `docs/superpowers/specs/2026-07-15-textcaster-push-in-design.md` (52ad480)
Claims verified against milestone-1 code (push.ts, push-guard.ts, sqlite.ts,
ingest.ts) and probed against installed feedsmith 2.9.6 / hono.

**Verdict: not ready as-is — but close, and admirably lean. H1+H2 (a few
lines of §5) are non-negotiable for real-hub interop; H3/H4 are one-sentence
pins preventing bugs the tests would miss; H5 is one map. The ponytail pass
found nothing speculative — only two genuine shrinks.**

## Ponytail verdicts

| Element | Verdict |
|---|---|
| Second table (`push_subscriptions`) | **keep** — shapes genuinely diverge from M1's inbound table; merging needs nullable columns + a direction flag + two unique constraints, which is more complexity, not less |
| Six repo methods | **shrink** — the three single-row lookups (ByToken/ByTopic/ActiveForUser) collapse into one `findPushSubscription(filter, now?)` using the filter-object pattern already in the codebase → 4 methods, 2 fewer contract pins |
| pending/active states | keep (minimum viable), contingent on the H3 pin |
| rssCloud receiving | **keep, named first-defer candidate** — identity-adjacent (Winer lineage), M1's hub is its test peer, ~60–80 lines on shared infra; if the batch needs slimming this is the cut, re-add signal = a followed feed actually advertising `<cloud>` |
| Slow-poll ×10 counter | keep — already minimal, restart-safe in the correct direction |
| Link-header discovery | keep — and it's not a "fallback": W3C WebSub requires supporting Link headers; header-only publishers are spec-legal and common |
| Auto-subscribe zero-config / PUSH_IN=on default | keep — rationale sound |
| §6 `ingestItems` split | **keep + extend**: `parseFeed` today returns items only, so discovery as specced re-parses every poll body. Return `{ items, meta }` from the one parse; discovery reads `meta`. Same refactor, one parse |
| No-backoff ceiling | keep — correctly marked |

Net: real cuts ≈ 2 repo methods + 1 redundant parse. Nothing speculative.

## Holes

### H1 — DESIGN-BREAKING (interop): sha256-only signature rejection breaks major hubs

The HUB picks the algorithm. W3C WebSub allows sha1/sha256/sha384/sha512 and
the biggest real hubs (Google's pubsubhubbub, Superfeedr) sign `sha1=`.
As specced, subscriptions to Google-hubbed feeds verify fine, then every fat
ping is discarded forever — silently, because slow-poll masks it at 10×
latency. Accept all four: parse `method=hex`, HMAC with `method`,
timing-safe compare.

### H2 — spec-conformance + oracle: 403 on bad signature is itself wrong

W3C WebSub §8: on mismatch the subscriber MUST respond 2xx and ignore the
payload. A 403 both risks the hub dropping the subscription (repeated
non-2xx = dead subscriber) and hands attackers a signature-validity oracle.
Always 202; discard on mismatch; log.

### H3 — confirmed contradiction: pending-row deadlock

§4.2 subscribes only when no pending/active row exists; §4.4 says failures
leave the row pending and "the next tick retries" — which the pending row
blocks. Pin: pending rows get `expires_at = now + 10min`; the discovery gate
skips only UNEXPIRED pending/active rows; the `(user, mode)` upsert
overwrites an expired pending row on retry.

### H4 — real bug: renewals must NOT rotate token/secret

Fresh token per subscribe attempt + DO UPDATE means a renewal changes our
callback URL. WebSub identity is (topic, callback): the hub creates a
SECOND subscription while the old lease lives out (double delivery), and the
old token is gone from our DB so the old subscription's pings 404 — repeated
failures may get both dropped. Pin: token+secret generated once per
(user, mode), reused across renewals; DO UPDATE only
endpoint/topic/state/expires_at.

### H5 — MEDIUM: thin-ping amplification

`POST /rsscloud/notify` is unauthenticated and topics are public (they're in
the timeline). Each match triggers a full `ingestRemoteUser` fetch. Lazy
fix: in-memory `Map<userId, lastIngestMs>`, skip if < 30s since last
(restart = one extra fetch, harmless). One map, one if.

## Ambiguities to pin

- **Money test vs SSRF guard:** A's hub runs `checkCallbackUrl` on B's
  bridge callback, which won't resolve publicly — the registration dies
  before verification. The seam already exists (`handleWebSubRequest` takes
  `lookupFn`): pin that the test injects a lookupFn resolving the bridge
  host to a public IP.
- Hub omits `hub.lease_seconds` on the verification GET (older hubs do):
  fall back to the requested lease; don't NaN the expiry.
- Feedsmith's format discriminator is `parsed.format` (`'json' | 'atom' |
  'rdf'`, rss default) — not `type`; write discovery against it.
- Fat-ping body cap inherits F4's ceiling — carry the ledger line, don't
  re-litigate.
- GET `/rsscloud/notify` 404-on-unknown is a follow-list oracle while POST
  isn't — both moot (the follow list is public in the timeline); say so in
  one sentence so nobody "fixes" either.

## Verified sound (probed — don't re-check)

- Feedsmith discovery fields are real: RSS `feed.atom.links[{href,rel}]` +
  `feed.cloud{domain,port,path,protocol}`; Atom `feed.links`; JSON Feed
  `feed.hubs` + `feed.feed_url`.
- Hono `c.req.arrayBuffer()`/`.text()` for HMAC-before-parse; cap mechanics
  mirror ingest's.
- `checkCallbackUrl` reusable as-is for hub/cloud endpoints;
  `redirect:'manual'` matches M1 convention (a 301ing hub just fails until
  next tick — rare, acceptable).
- Migration runner takes 2→3 as-is; `(user_id, mode)` DO-UPDATE upsert has
  the M1 precedent.
- Renewal thresholds coherent with M1 lease constants; slow-poll
  restart-resets in the safe direction.

## What must change before planning

Rewrite §5's signature handling (H1: all four algorithms; H2: 2xx-and-
discard). Add the H3 pending-expiry pin, the H4 token-stability pin, and
H5's debounce map. Add the money-test lookupFn pin and the lease_seconds
fallback. Optional shrinks: collapse the three lookups; return `{items,
meta}` from the §6 split.
