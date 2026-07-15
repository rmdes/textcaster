# Textcaster — design

Date: 2026-07-15
Status: design approved (brainstorm); implementation not started
Author: Ricardo (rmdes) with Claude Code

## What it is

Textcaster is a clean, modern implementation of the rss.chat / Textcasting
idea: a **multi-user, real-time social timeline built natively on feeds**,
where the boundary between "post here" and "bring your own site" dissolves —
people who post through the instance and people whose posts come from their
own website's feed coexist as first-class citizens of the same timeline.

It deliberately unifies two worlds that have kept their distance: **RSS /
OPML / JSON Feed / Textcasting** (Dave Winer's lineage) and the **IndieWeb**
(Micropub, Webmention, IndieAuth, microformats). Textcaster takes the useful
building blocks from both and refuses the ideological/purity blocks between
them. The name is itself an attribution — to Dave Winer's
[textcasting.org](https://textcasting.org), the RSS tradition, and the
IndieWeb community whose standards it builds on.

## The core idea: three kinds of user, one timeline

A "user" on a Textcaster instance is one of three kinds, and the timeline
treats them identically:

1. **Local** — signs up and posts *through* the instance; the instance
   generates and hosts their feed. (This is rss.chat's existing model.)
2. **Claimed remote** — a person proves ownership of their own domain via
   **IndieAuth** (the `rel="me"` bidirectional check, their **h-card** for
   identity), then points the instance at their site's feed as their post
   source. A verified member whose content lives on *their* domain; the
   instance represents and threads them.
3. **Unclaimed remote** — any external feed (a news site, a blog) added by a
   member as a followable, read-only entity. No consent, no auth — a
   subscription surfaced as a first-class citizen of the timeline.

Following works uniformly across all three. This coexistence is the product's
distinctive claim; nothing else builds exactly this.

## Building blocks and their jobs

| Standard | Role in Textcaster |
|---|---|
| RSS 2.0 / JSON Feed / OPML | The feed substrate — ingest for remotes, output for locals, OPML for the follow/subscription graph |
| Microformats2 (h-entry / h-feed / h-card) | Alternate ingestion path (parse a site with mf2 but no clean feed) **and** an output format the instance can emit |
| IndieAuth + h-card | The "claim your spot" flow and remote identity |
| Webmention | Cross-site conversations, in and out — the reply layer that isn't instance-local |
| Micropub | Publishing *into* your instance account from any external editor |
| WebSub + rssCloud | Cross-instance real-time — subscribe to remote feeds that offer push (instead of polling), and emit push on our own feeds |
| ActivityPub | Optional reach into the fediverse — not load-bearing |
| Textcasting profile | The behavioral contract for posts: optional titles, Markdown+HTML dual content, unlimited length, editability, pass-through, enclosures |

## Architecture

**Headless core, many equal clients.** The backend is a source-of-truth
service with a documented, token-accepting HTTP + SSE API. The web app is
*one client* of that API. This is the same architecture future frontends
(native, mobile, TUI) and future IndieWeb endpoints (Micropub-in, IndieAuth)
need — one API, many equal consumers — so building headless from day one is
not speculative; it is the decision that makes those futures drop in.

**Two deployables:**

1. **Core API** (TypeScript / Node) — the storage-agnostic repository, the
   domain logic (users local/remote, posting, feed ingestion, the unified
   timeline, following, conversations), an in-process event bus, an SSE
   stream, token-based auth, feed generation, and the WebSub/rssCloud + poller
   ingestion. Exposes an HTTP+JSON API + SSE. The single source of truth.
2. **Web app** (SvelteKit) — a client. Server-side `load` calls the Core API
   server-to-server so a full timeline renders **without JavaScript**;
   browser islands hit the same API + SSE for the live, no-refresh feel.
   Forms (compose, follow) are plain POSTs, progressively enhanced.

**Language:** TypeScript. Chosen because the two communities Textcaster
unites — Dave's RSS world and the IndieWeb world — are *both* natively
JavaScript, so TS is the lowest-friction language for "others to join," and
the entire substrate (feed parsers, mf2 parsers, IndieAuth, Micropub, Fedify
for ActivityPub, OPML) already exists and is battle-tested in Node.

**Frontend:** SvelteKit. Best-in-class progressive enhancement (no-JS works
by construction, then enhances), leanest full-stack TS, fits an app that is
mostly a live timeline. Clean backend/frontend separation is a hard
requirement so alternate frontends can be built against the API later.

### Storage — pluggable, three backends

The operator chooses the backend; the stack bootstraps it cleanly on startup
(the adapter creates its own schema/collections). Deployment targets:

- **SQLite** — the default (dev + small self-host). Single file, zero extra
  service. `node:sqlite` (Node 22+) or `better-sqlite3`.
- **PostgreSQL** — the Docker self-hoster's likely choice; the "serious"
  default for a real community instance.
- **MongoDB** — the Cloudron operator's choice (a free Cloudron DB addon), and
  a natural fit for document-shaped feed/mf2 content.

**Consequence, accepted consciously:** the core is **storage-agnostic** — a
repository interface with adapters (the two SQL backends share most code via a
query builder; Mongo is its own adapter). Core logic must not lean on
backend-specific features. This is *why* the real-time design uses an
in-process event bus rather than Postgres `LISTEN/NOTIFY` or Mongo change
streams — the firehose works identically on all three. A single repository
test-suite validates every adapter: write the behavior once, prove each
backend against it.

### Real-time — two layers

- **Intra-instance** (connected users see posts appear live, no refresh): an
  **in-process event bus** — every write, whether a local compose or a
  remote-feed item arriving from the poller, emits an event that an **SSE**
  stream pushes to connected browsers. SSE over WebSocket for the firehose:
  one-way (server → timeline), plain HTTP, auto-reconnecting, no-JS-adjacent.
- **Inter-instance** (remote content arrives fast; our feeds notify others):
  **WebSub + rssCloud**, both directions — subscribe to them on remote feeds
  that offer it (push instead of poll), and emit them on our own feeds so
  downstream subscribers get pushed. Polling is the fallback, not the default.

### No-JS by construction

SSR renders the timeline so it works fully without JavaScript (posts on load,
refresh for more). With JS, one island upgrades to the live SSE firehose.
Compose and follow are plain form POSTs, enhanced when JS is present.

## The spine (first slice to build)

The spine is the thinnest runnable thing that is unmistakably *this* product —
the coexistence of local and remote users in one live timeline — proven end
to end, establishing the whole architecture. It is a thin version of *both*
halves at once, so the spark is present in the first thing you can open.

**In scope:**

- The `User` model with `kind: local | remote`.
- Add-a-remote-user (a feed URL the poller ingests into that user's posts).
- Local compose (store a post).
- The unified everyone-timeline.
- The SSE firehose, so both local posts and freshly-polled remote items
  appear live without a refresh (short-interval polling for remotes in the
  spine).
- The SQLite adapter behind the repository interface (the interface designed
  for Postgres/Mongo, those adapters deferred).
- The SvelteKit timeline + compose + add-remote forms — working without JS,
  enhanced with the live island.
- The headless Core API surface the spine needs (token-authed compose,
  add-user, timeline read, SSE stream).

**Deferred, in rough order:**

1. Per-user **feed output** + **WebSub/rssCloud** — the milestone where
   cross-instance real-time lands and the loop closes: once a local user's
   posts are emitted as a feed, another instance ingests them as a remote user,
   so two instances federate over plain RSS with zero extra protocol.
2. Following / filtering (beyond the everyone-timeline).
3. Reply threading and conversations.
4. Real auth + the three-tier account model (IndieAuth claiming).
5. Micropub-in.
6. Postgres + Mongo adapters.
7. Webmention (in/out), ActivityPub-out, media/enclosures.

## Non-goals (v1)

- Not an Indiekit clone or a reimplementation of it — its own standalone thing.
- Not a monolith — clean backend/frontend separation is required from the start.
- Not tied to one database — storage is pluggable from the start.
- No monetization, no moderation-labeling infrastructure, no collaborative
  editing — out of scope for the foreseeable product.

## Testing approach

Test-driven, per the project's workflow norms. The storage-agnostic repository
gets one behavioral test-suite run against each adapter (SQLite now,
Postgres/Mongo later). The Core API is tested over HTTP. The SvelteKit app's
no-JS paths are testable without a browser (plain POST/GET); the live island
is tested against the SSE stream.

## Open items to settle at build time

- Project/package layout (monorepo with `core/` + `web/`, or two repos).
- Exact API shape and versioning scheme (documented, OpenAPI likely).
- SQL query-builder choice (Kysely / Drizzle) for the shared SQL adapter.
- Auth token/session mechanics for the web client (httpOnly cookie held by the
  SvelteKit server, proxying to the token API).
- Licence and the attribution/credits file (Dave Winer / textcasting.org, the
  RSS tradition, the IndieWeb community, rss.chat lineage).
