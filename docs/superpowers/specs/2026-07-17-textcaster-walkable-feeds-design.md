# Textcaster — walkable feeds (threadwalker parity) design

Date: 2026-07-17
Status: design approved (brainstorm); spec pending review
Author: Ricardo (rmdes) with Claude Code
Prior art: `2026-07-16-textcaster-threading-design.md` (source:inReplyTo /
thr: dual-emit, comments feeds, injectors); the parallel session's firehose
work (`/users/rss.xml` + source:account injection, push topic); ingest-side
permalink-guid fix (rss.chat items' guid-as-permalink). Motivating
evidence: Dave Winer's reference `threadwalker`
(`rss.chat/examples/threadwalker/walker.js`) run live against a Textcaster
instance on 2026-07-17 — the tree walks, but the starting-post guid match
fails and every author prints `?`. Discussion:
https://github.com/scripting/rss.chat/issues/13.

## What this milestone adds

Two emission-layer changes that make Textcaster conversations walkable by
Dave's threadwalker verbatim, closing our produce/consume asymmetry:

1. **Permalink guids outbound.** Local posts' emitted `<guid>` becomes the
   post's permalink URL (bare element, spec-default `isPermaLink=true`) —
   the rss.chat convention our ingest already honors inbound.
2. **`source:account` on every multi-consumer feed.** Comments feeds and
   per-user feeds gain the injection the firehose already has.

Plus a **walker-parity test** that pins Dave-compatibility permanently by
mimicking walker.js's exact semantics in-process.

## Probed facts (2026-07-17, do not re-derive)

- walker.js matches the starting post with `item.guid === guidStartingPost`
  (plain string compare, xml2js `explicitArray: false`). ANY attribute on
  `<guid>` makes xml2js yield an object → the compare silently never
  matches. Run 1 against our feeds printed nothing for exactly this reason.
- walker.js reads the comments feed URL from `comments.$.feedUrl` — our
  `<source:comments count feedUrl/>` attribute shape is already correct
  (run 2 walked the full tree: 4 posts, 3 authors, correct nesting).
- walker.js prints authors from `item["source:account"]._` — absent on our
  per-user and comments feeds today (firehose only), hence `?`.
- `replyWireElements` (feed.ts:36-42) already emits `source:inReplyTo`
  WITHOUT `isPermaLink=false` (and `thr:` with `href`) when the ref is a
  URL — permalink refs flow through the existing branch untouched.

## Design

### Permalink guids (emission layer only)

One derivation function in `core/src/domain/feed.ts`:

```ts
// The emitted identity of a local post. With a public URL the guid IS the
// permalink (bare <guid>, spec-default isPermaLink=true — the rss.chat
// convention our ingest already honors). Without one, the stored UUID with
// isPermaLink="false" (a bare non-URL guid would be a lie).
function localGuid(publicUrl: string | null, p: Post): { value: string; isPermaLink: boolean }
```

- `publicUrl` set → `{ value: `${publicUrl}/post/${p.id}`, isPermaLink: true }`
  → serializer emits `<guid>URL</guid>` with NO attribute.
- `publicUrl` null → today's `{ value: p.guid, isPermaLink: false }`.

PIN (the whole point of Gap 1): the URL-form element must be
**attribute-free** in the emitted XML. If feedsmith serializes
`isPermaLink: true` as an explicit `isPermaLink="true"` attribute (probe at
plan time), pass the guid WITHOUT the isPermaLink key instead — an
explicit-true attribute still breaks walker.js's string compare. The
walker-parity test asserts the emitted shape either way.

Applied at every serialization of a LOCAL post:

- per-user RSS items, comments-feed items, firehose items (the three
  render paths in feed.ts);
- JSON Feed `id` (same derived value — one identity everywhere);
- the injectors' guid keying: `injectSourceComments` / `injectSourceAccounts`
  call sites pass the EMITTED guid (injectItemElements matches on the
  `<guid>` element's value in the XML it's injecting into);
- reply refs: `source:inReplyTo` and `thr:in-reply-to` carry the PARENT's
  emitted guid — URL form when publicUrl is set, which the existing isUrl
  branch emits attribute-free. Same value a peer stores as that parent's
  guid, so cross-instance resolution matches on first ingest.
- pushed fat-ping bodies: rendered by the same feed renderers — parity is
  free, but the plan verifies it (push.ts renders + injects itself).

**Storage is untouched.** `posts.guid` stays the creation-time UUID; the
permalink form is derived at emission. No migration, no dual-write, and the
UUID remains the internal fallback identity.

**Remote posts are untouched.** Pass-through re-emission keeps the origin's
guid verbatim (their identity, not ours) — only `source: 'local'` posts get
derived guids.

**Accepted one-time break, recorded honestly:** the emitted guid is item
identity to subscribers. Any feed reader or peer that already ingested our
UUID-guid items will see every local post as new once. Pre-release, no real
peers — this is exactly why now. (Ingest-side note: a peer that ingested
the UUID form earlier and now sees the URL form would dedup-miss; we do NOT
build a transition shim. Delete-and-refollow is the dev-era answer.)

**Self-ingest coherence:** another Textcaster following our feed stores
guid = our permalink URL; replies referencing that URL resolve by
guid-or-link matching (both match — guid equals link). Our OWN reply
resolution over internal ids is unaffected.

### source:account everywhere

- Comments feeds (`/post/:id/comments.xml`): inject
  `<source:account service="{host}">{author.handle}</source:account>` per
  item — multi-author, this is the real gap.
- Per-user feeds (`/users/:handle/feed.xml`): same injection (single
  author, but rss.chat does it and walker.js reads it on the starting
  item).
- Firehose: already done (parallel session) — untouched.
- `service` = host of publicUrl, `name` = handle: matches the firehose's
  existing choice; consistency beats bikeshedding the value.
- Injection requires publicUrl (host derives from it) — same gating as the
  firehose's injection. Without publicUrl, feeds stay as today.

### Walker-parity test (the money test)

One core test that mimics walker.js's semantics — not a port, a parity pin:

- Build a threaded conversation over HTTP (session helpers), publicUrl set.
- Parser: whatever the test can do with installed deps (feedsmith's parse
  if it exposes guid attributes faithfully, else a minimal targeted
  extraction) — NO new dependency; probed at plan time.
- Fetch the author's feed via `app.request`, parse with an attribute-aware
  XML parse, and locate the starting item by **plain string compare on the
  guid** — this assertion is the whole point: it fails if `<guid>` ever
  grows an attribute again.
- Recursively follow `source:comments`' `feedUrl` attribute through
  `app.request`, collecting `(author-from-source:account, first text line,
  depth)`.
- Assert the exact indented outline: authors by name (never `?`), correct
  nesting, guid === the post's public permalink.

Plus regular unit coverage: `localGuid` both branches; reply-ref URL form;
JSON Feed id parity; remote pass-through guid untouched.

## Interaction with in-flight work

The parallel session owns the firehose/discoverability surface (feed.ts,
app.ts are shared). Execution coordinates the usual way: read current file
state before every edit, explicit staged paths, small commits. No API,
schema, or web-app changes in this batch — it is core emission + tests
only.

## Non-goals

Migrating stored guids; any ingest change (already permalink-aware); a
transition shim for the one-time identity break; PRing walker.js's
object-guid fragility upstream (bare guids make his code work as-is —
that's the point); JSON Feed changes beyond the `id` value; changing
`source:account`'s service/name scheme; WebSub topic URLs (feed URLs,
unaffected); the web UI.
