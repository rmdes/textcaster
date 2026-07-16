# Textcaster — reply threading & conversations design

Date: 2026-07-16
Status: design approved (brainstorm); spec pending review
Author: Ricardo (rmdes) with Claude Code
Basis: `2026-07-15-textcaster-design.md` deferred item 3 ("Reply threading and
conversations"); Textcasting source namespace (source.scripting.com), whose
`source:inReplyTo` (added 5/16/2026) is this milestone's native wire form.

## What this milestone adds

Replies as first-class posts in the one timeline, a conversation (thread)
page, and reply metadata that survives the feed substrate in both directions
— RSS 2.0 out/in (source namespace + Atom Threading), mf2/h-entry in, JSON
Feed out/in via extension — so a future Webmention milestone bolts on
without a migration.

Decisions taken at brainstorm:

- **Replies live in the timeline** like any post, marked, with a thread page
  (`/post/<id>`) grouping the conversation flat, oldest-first. The firehose
  hides nothing; no bumping, no counts.
- **Reply targets are timeline posts** (local or remote) via a reply button.
  No freeform reply-to-URL composer until Webmention-out makes it useful.
  Ingested remote replies may point at URLs we don't hold — those render as
  "in reply to ↗" external links with no thread page.
- **The wire identity of a reply target is the target's `url` ?? `guid`**,
  matched against either on resolution. No public per-post page URLs are
  minted for this; a local post's feed guid is already stable and unique.
- **Conversation grouping is a stored `thread_root_id` plus adoption**
  (approach C): O(1) thread reads, no recursion anywhere (adapter-neutral —
  no SQL-specific CTEs), and out-of-order feed arrival heals.

## Data model — migration 5

Append-only, as ever:

```sql
ALTER TABLE posts ADD COLUMN in_reply_to TEXT;      -- wire ref of the target (url ?? guid), null = not a reply
ALTER TABLE posts ADD COLUMN thread_root_id TEXT;   -- root post id when I'm a DESCENDANT; null for roots and non-replies
CREATE INDEX posts_thread_idx ON posts (thread_root_id);
CREATE INDEX posts_reply_to_idx ON posts (in_reply_to);
```

Semantics:

- A non-reply post: both null. No backfill.
- A reply whose target resolves to a known post P:
  `thread_root_id = P.thread_root_id ?? P.id`.
- A reply whose target does NOT resolve (orphan): `in_reply_to` set,
  `thread_root_id` null — it is its own root until adopted. Replies TO an
  orphan root at the orphan (`P.thread_root_id ?? P.id` covers this).
- **Adoption:** when any post P arrives (insert time, local or ingested),
  orphans whose `in_reply_to` matches P's `url` or `guid` are adopted:
  1. `UPDATE posts SET thread_root_id = <P.thread_root_id ?? P.id>
     WHERE in_reply_to IN (P.url, P.guid) AND id != P.id`
  2. for each adopted orphan O, re-root O's own subtree:
     `UPDATE posts SET thread_root_id = <new root> WHERE thread_root_id = O.id`
  Both are indexed single UPDATEs — no recursion (a subtree all carries
  O.id as its root, by construction). Runs on every insert; a no-op for
  posts nothing points at.

Thread read: `getThread(rootId)` = `WHERE id = rootId OR thread_root_id =
rootId ORDER BY published_at ASC, id ASC`.

## Repository additions (contract-tested)

```ts
findPostByRef(ref: string): Promise<Post | undefined>   // matches posts.url OR posts.guid
getThread(rootId: string): Promise<TimelineEntry[]>     // root + descendants, (published_at, id) ASC
adoptOrphans(parent: Post): Promise<void>               // the two UPDATEs above
getPost(id: string): Promise<Post | undefined>          // if not already present
```

`insertPost` itself is unchanged; the service/ingest layer calls
`adoptOrphans` after each successful insert. `Post` gains
`inReplyTo: string | null` and `threadRootId: string | null`; the timeline
join surfaces both on `TimelineEntry` (the web marker needs them).

## Service & API

- `POST /posts` accepts optional `inReplyTo: <post id>` (the reply button
  always targets a post we hold). The API resolves the target post before
  calling the service — unknown target id → 404, matching the
  handle-resolution style. The service stores
  `in_reply_to = target.url ?? target.guid`
  and `thread_root_id = target.threadRootId ?? target.id`, then adopts.
- Ingested items: `ParsedItem` gains `inReplyTo: string | null`. `ingestItems`
  resolves via `findPostByRef`, sets the same fields, adopts after insert.
- `GET /post/:id/thread` (public read) → `{ thread: TimelineEntry[] }` —
  the conversation containing post `:id` (resolve to its root first:
  `threadRootId ?? id`), flat, oldest-first. 404 unknown id.
- Replies flow through the existing bus/SSE untouched — they are posts.

## Wire formats

### RSS 2.0 out — dual-emit, source namespace first-class

Per reply item (probed against installed feedsmith 2.9.6 — it generates
`sourceNs` and `thr` and declares both namespaces):

- `<source:inReplyTo>` — the Textcasting-native form — emitted whenever the
  stored ref is an http(s) URL. For a non-permalink ref the docs require
  `isPermaLink="false"`; **plan-time probe:** whether feedsmith's `sourceNs`
  generation supports attributes. If not, guid-only refs get `thr:` only —
  never a `source:inReplyTo` that violates its default-permalink contract.
- `<thr:in-reply-to ref="<ref>" href="<ref when URL>">` — always (RFC 4685,
  the WordPress/Atom lineage; `ref` carries non-permalink ids natively).

### JSON Feed out — `_textcaster` extension

JSON Feed 1.1 has no reply field; underscore extensions are its mechanism:
`"_textcaster": { "in_reply_to": "<ref>" }` per reply item. **Plan-time
probe:** feedsmith `generateJsonFeed` custom-key pass-through, and
`parseJsonFeed` retention of unknown keys. If parse-side drops them, JSON
Feed reply INGESTION degrades (documented; RSS is the primary federation
format) — emission is still required.

### Ingestion — source namespace preferred

`ParsedItem.inReplyTo` sourced per format, first match wins:

1. RSS: `item.sourceNs.inReplyTo.value` (probed: feedsmith parses it), else
   `item.thr.inReplyTos[0].ref ?? .href` (probed).
2. mf2/h-feed: JF2 `in-reply-to` (probed: mf2tojf2 surfaces `u-in-reply-to`;
   value may be a string or an array/object — plan-time probe pins the
   shapes; take the first URL).
3. JSON Feed: `_textcaster.in_reply_to` (probe above).

Atom in: feedsmith exposes `thr` on Atom items too (same namespace) — same
mapping applies.

## Web UI

Design-system rules apply; UI tasks invoke `ui-ux-pro-max` first.

- Reply button on every timeline/lens post → the existing composer with the
  hidden target id (plain form POST, no-JS first-class).
- Timeline/lens posts carrying `threadRootId` (or being a thread root that
  the reader arrived at) show a marker linking to `/post/<threadRootId ?? id>`
  ("view conversation"). A reply whose ref never resolved shows
  "in reply to ↗" linking the raw URL when it is one.
- `/post/<id>` — SSR thread page: the conversation flat, oldest-first, with
  the usual live island filtered client-side to `threadRootId` matches
  (same accepted staleness model as the lenses).

## Deferred — tracked, not dropped

- **`source:comments` + per-post comments feed** (`GET /post/:id/comments.xml`
  + `<source:comments count feedUrl>` on items with replies) — the
  Winer-native way for aggregators to pull a conversation. **Blocked solely
  on tooling:** the element is 6 days old (7/9/2026) and feedsmith 2.9.6
  silently drops it in BOTH directions (probed). **Re-add trigger: the first
  feedsmith release whose parse/generate types mention `comments` under
  `sourceNs` — check on every dependency bump.** Also ledgered in
  `.superpowers/sdd/progress.md` so it survives this spec going historical.
- Textcasting alignment batch (out of threading scope): `source:self`,
  compact `source:cloud`, `source:subscriptionList`/`source:blogroll` on our
  OPML surfaces — cheap adoptions for a between-milestones batch.
- Webmention in/out (design item 7) — the stored per-reply target URL is
  exactly what it needs; nothing to migrate.

## Non-goals

Reply-to-arbitrary-URL composing, reply counts/notifications, timeline
bumping, nested rendering, fetching reply context for unresolved refs,
comment moderation, editing threads. `source:comments` (above — deferred
with trigger, not a non-goal forever).

## Testing

- Contract: `findPostByRef` (url and guid match), `getThread` order across
  same-ms ties, adoption incl. an orphan WITH its own descendants (subtree
  re-roots), `getPost`.
- Unit: wire mapping out (dual-emit shapes; no `source:inReplyTo` for bare
  guids unless attrs probe passes) and in (source-preferred order, thr
  fallback, JF2, `_textcaster`).
- HTTP: `POST /posts` with `inReplyTo` happy/404; `GET /post/:id/thread`
  content + order + 404.
- **Money test (definition of done):** two in-process instances. B follows
  A's feed. A local-composes a post; B ingests it. A local user on B replies
  via the reply button; B's feed now carries `source:inReplyTo` +
  `thr:in-reply-to`; A ingests B's feed and A's thread page for the original
  post shows the reply — a conversation federated over plain RSS, round
  trip. Sibling: the same flow through the mf2/h-feed path (reply ingested
  from an h-entry with `u-in-reply-to`).
- Web: form-action test for reply compose; thread-page load test; island
  predicate extended for the thread lens.

## Sequencing

1. Migration 5 + repository additions + contract pins.
2. Service/API: reply compose, resolution + adoption, thread endpoint.
3. Wire: feed emit (source + thr + `_textcaster`) and `ParsedItem.inReplyTo`
   ingestion across all three paths (probes first).
4. Web: reply button, markers, thread page + live island.
5. Money test + RUNNING.md.
