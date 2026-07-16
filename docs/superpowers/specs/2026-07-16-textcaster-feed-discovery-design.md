# Textcaster — feed discovery (autodiscovery + h-feed)

Date: 2026-07-16
Status: design approved (brainstorm); implementation not started
Author: Ricardo (rmdes) with Claude Code
Basis: design spec `docs/superpowers/specs/2026-07-15-textcaster-design.md`
(microformats2 as an "alternate ingestion path"); surfaced by the following
milestone's bulk OPML import, where many outlines pointed at HTML pages
(`notiz.blog/`, `aaronparecki.com/all`) or homepages rather than feed URLs and
failed ingestion with "Unrecognized feed format".

## What this is

When a followed URL returns HTML instead of a parseable feed, ingestion today
fails. This milestone makes those URLs followable by **discovering** the feed:

1. **Autodiscovery** — an HTML page that advertises a feed via
   `<link rel="alternate" type="application/rss+xml|atom+xml|feed+json">`
   resolves to that feed, which is then fetched and parsed normally.
2. **h-feed (microformats2)** — an IndieWeb page with no feed at all, but with
   `h-entry` microformats, is parsed directly: the HTML page *is* the feed.

Polling remains the driver; discovery is a fallback that runs only when the
primary feed parse fails. A prerequisite fix already landed
(`1490d59`): feed fetches now send a descriptive `User-Agent` + feed `Accept`
header, so Cloudflare/WAF-protected feeds return the real feed instead of an
HTML challenge. Discovery handles the genuinely-HTML cases that remain.

Decisions taken at design time:

- **One hop only.** Discovery resolves at most ONE additional URL (the
  discovered feed). It never recurses into the discovered feed's own links.
- **Autodiscovery rewrites the stored `feedUrl`** to the discovered feed
  (self-healing): the bad URL is fixed once, and every later poll hits the
  real feed directly. h-feed-only pages keep the HTML page as their
  `feedUrl` (the page is re-parsed each poll).
- **One dependency, one parse.** `microformats-parser` yields both the
  `rel-urls` (autodiscovery links, with their `type`) and the h-feed `items`
  from a single parse of the HTML — so autodiscovery and h-feed share it.
- **Discovery runs at poll/ingest time, never at OPML-import time** — import
  stays fetch-free by design (SSRF posture + backfill rules).

## 1. The discovery ladder (`ingestRemoteUser`)

After fetching `feedUrl` and reading the body, `ingestRemoteUser` tries the
normal `parseFeedWithMeta`. On success, nothing changes. On failure **and**
when the body looks like HTML (first non-whitespace char `<`, or an
HTML-ish content-type), it enters discovery on the HTML already in hand:

1. **Autodiscovery.** `discoverFeed(html, pageUrl)` returns the first
   feed-typed `<link rel="alternate">` URL in document order (main feed
   precedes comments feed in WordPress output), resolved absolute against
   `pageUrl`.
   - If a feed URL is found and it differs from the one just fetched:
     - **SSRF guard**: `checkCallbackUrl(discoveredUrl)` — the URL is
       attacker-influenced content; reject loopback/private ranges before any
       request (same guard push-in uses).
     - Fetch it (with the feed User-Agent/Accept headers), parse via
       `parseFeedWithMeta`. On success: **persist** the discovered URL with
       `repo.updateFeedUrl(user.id, discoveredUrl)`, then ingest its items.
     - If the discovered URL equals the URL that just failed, do NOT re-fetch
       (no loop) — fall through to h-feed.
2. **h-feed.** If no feed link, `discoverFeed`'s `hentries` (parsed from the
   same HTML) are ingested directly. The `feedUrl` is left unchanged — the
   page is the feed and is re-parsed on each poll. `hasPostsByAuthor`
   backfill rules and guid dedup apply exactly as for feeds.
3. **Neither.** No feed link and no h-entries → the original parse failure
   stands; `pollAll`'s per-user catch logs it (e.g. "no feed found").

`ingestRemoteUser`'s return shape (`{ inserted, discovery }`) is unchanged;
the WebSub/rssCloud `discovery` metadata is still taken from a successfully
parsed feed (autodiscovered or direct). h-feed ingestion returns
`NO_DISCOVERY` (an HTML page advertises push via its own `<link rel="hub">`,
out of scope here).

## 2. `discoverFeed` (pure, no I/O)

New module `core/src/domain/discovery.ts`:

```ts
export interface Discovered {
  feedUrl: string | null          // first alternate feed link, absolute
  hentries: ParsedItem[]          // h-feed items (empty if none)
}
export function discoverFeed(html: string, pageUrl: string): Discovered
```

- Parses `html` once with `microformats-parser` (`mf2(html, { baseUrl: pageUrl })`).
- **feedUrl**: from the parse's `rels`/`rel-urls`, the first entry whose rels
  include `alternate` and whose `type` is one of
  `application/rss+xml`, `application/atom+xml`, `application/feed+json`,
  `application/json`. Absolute (the parser resolves against `baseUrl`).
- **hentries**: flatten `h-feed` → child `h-entry` items (and top-level
  `h-entry` items). Each maps to a `ParsedItem`:
  - `guid` = `uid` prop, else `url` prop, else `fallbackGuid(title, content, rawDate)` (reuse ingest's helper).
  - `url` = `url` prop or null.
  - `title` = `name` prop when present AND not equal to the content (mf2
    "implied name" often duplicates content; drop it then) — else null.
  - `content` = `content.value` (plain text) or `summary`, else `name`.
  - `publishedAt` = `published` dt-property parsed to ISO, else now (clamped
    to now if future, mirroring the feed path).
- Exported as a pure function so it is unit-testable without network.

`ParsedItem` is the existing ingest type; `discovery.ts` imports it (and
`fallbackGuid` if exported, or the mapping duplicates the one-line hash — TBD
at plan time, prefer exporting `fallbackGuid`).

## 3. Data model — `updateFeedUrl`

No migration (the `feed_url` column exists). One new repository method,
contract-pinned and adapter-neutral:

```ts
updateFeedUrl(userId: string, feedUrl: string): Promise<void>
```

- SQLite: `UPDATE users SET feed_url = ? WHERE id = ?`.
- Contract pins: after `updateFeedUrl`, `getUser` reflects the new URL;
  updating a non-existent id is a silent no-op (consistent with the other
  idempotent writes).

Only autodiscovery calls it (h-feed leaves `feedUrl` as the page URL).

## 4. Dependency

`microformats-parser` (npm, actively maintained, the reference mf2 parser for
the JS IndieWeb ecosystem). Justification per the project's dependency rule:

- mf2 is a real specification (nested microformats, the value-class pattern
  for dates, implied properties) — hand-rolling it is error-prone and exactly
  the kind of thing a battle-tested parser should own.
- feedsmith parses feeds only (no HTML/mf2, no `rel` autodiscovery).
- The same parse yields autodiscovery links AND h-feed items, so the one dep
  covers both halves of the milestone — no second HTML parser.

Its exact output shape (`items`, `rels`, `rel-urls`, the `baseUrl` option,
how `type` is exposed on rel-urls) will be probed against the installed
package at plan-writing time before any code is embedded — the same
probe-before-embedding discipline used for feedsmith and kysely. If a
rel-url `type` is not exposed, autodiscovery falls back to a targeted
`<link rel="alternate" type=…>` scan of the HTML `<head>` (a small regex);
the plan will pick the confirmed approach.

## 5. The money test (end to end)

An in-process instance adds a remote user whose `feedUrl` is an HTML page. A
staged `fetchFn` returns: (1) the HTML page (with a `<link rel="alternate"
type="application/rss+xml" href="/feed.xml">`) for the page URL, and (2) a
valid RSS body for the resolved feed URL. After `ingestRemoteUser`:

- the feed's items are ingested as the user's posts, AND
- `getUser(id).feedUrl` has been rewritten to the discovered feed URL
  (so a second poll fetches the feed directly — asserted by the fetch stub
  seeing only the feed URL on the second call).

A sibling test: an HTML page with h-entries and NO feed link → the h-entries
are ingested, and `feedUrl` is unchanged.

## 6. Security

- The discovered feed URL comes from attacker-influenced page content, so it
  passes `checkCallbackUrl` (loopback/link-local/RFC-1918/ULA rejection)
  before any fetch — the same guard the push-in callbacks use. The DNS-rebind
  residual ledgered in milestone 1 applies equally and is not re-litigated.
- One-hop limit bounds amplification: a malicious page cannot chain us
  through many fetches; discovery issues at most one extra request.
- The 10s fetch timeout and `MAX_FEED_BYTES` cap apply to the discovered
  fetch exactly as to the primary feed fetch.

## 7. Testing

- `discoverFeed` unit tests (no network): `<link rel=alternate>` for rss /
  atom / json returns the absolute URL; relative href resolved against the
  page URL; multiple alternates → first feed-typed in document order;
  h-feed HTML → mapped `ParsedItem`s (guid from uid/url, date, title-vs-content
  rule); page with neither → `{ feedUrl: null, hentries: [] }`; a
  Cloudflare-challenge HTML → nulls.
- Contract suite: `updateFeedUrl` reflects in `getUser`; no-op on unknown id.
- `ingestRemoteUser` integration (staged fake fetch): HTML→autodiscover→feed
  ingests + persists the new `feedUrl`; discovered URL == failed URL does not
  loop; SSRF-rejected discovered URL → no second fetch, failure logged;
  h-feed-only page ingests h-entries and leaves `feedUrl` unchanged.
- Money test (§5) + the h-feed sibling.

## Non-goals

- OPML-time discovery (import stays fetch-free; discovery is a poll-time
  fallback).
- Recursively discovering the discovered feed's own `rel` links (one hop).
- WebSub/hub discovery from HTML pages (push-in already discovers hubs from
  feeds and Link headers; an HTML `<link rel="hub">` is out of scope here).
- Multiple feeds per site / letting the operator choose among discovered
  feeds (first feed-typed alternate wins).
- Writing h-feed OUT (this is ingestion only).

## Sequencing

1. `updateFeedUrl` repository method + contract pin.
2. `microformats-parser` dependency + `discoverFeed` module (autodiscovery
   links + h-feed mapping) with unit tests.
3. Wire discovery into `ingestRemoteUser` (the ladder, SSRF guard, persist)
   with staged-fetch integration tests.
4. Money test + h-feed sibling + RUNNING.md note (feeds behind HTML pages and
   IndieWeb h-feed sites are now followable).
