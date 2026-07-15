# Textcaster — following/filtering design

Date: 2026-07-16
Status: design approved (brainstorm); spec pending review
Author: Ricardo (rmdes) with Claude Code
Prior art: `2026-07-15-textcaster-design.md` (deferred item 2: "Following /
filtering (beyond the everyone-timeline)"); OPML named there as "the
follow/subscription graph" format.

## What this milestone adds

Per-local-user follow relationships across all user kinds, two filtered
timeline lenses (followed-timeline and per-author), and OPML both ways
(export a user's follows as a subscription list; import an OPML file to
bulk-create remote users and follow them). Filtering means "timeline scoped
to follows" — no mute, no block, no follower-of queries.

Constraint that shapes everything: **real auth comes later** (IndieAuth
milestone). There is no logged-in "me". Follows belong to a named local
user, and any visitor can view any user's lenses — they are *lenses*, not
private inboxes. The auth milestone later locks each lens to its owner
without changing the model. Write operations require the instance bearer
token, exactly like compose does today.

## Data model — migration 4

Append to `MIGRATIONS` (never edit earlier entries):

```sql
CREATE TABLE follows (
  follower_id TEXT NOT NULL REFERENCES users(id),
  followed_id TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (follower_id, followed_id)
) WITHOUT ROWID;
```

- Follower MUST be a `local` user — enforced in the domain layer (service),
  not by the schema.
- Followed may be any user (local or remote).
- Self-follow is allowed and not special-cased: the followed lens shows
  exactly the followed authors, and a user who wants their own posts in
  their own lens follows themselves (most timelines include "you" — here
  that is an explicit follow, zero extra code).
- Unfollow deletes the row. No soft-delete, no counts, no timestamps beyond
  `created_at`.

## Repository (contract-tested against every adapter)

```ts
addFollow(followerId: string, followedId: string): Promise<void>      // idempotent — re-follow is a no-op
removeFollow(followerId: string, followedId: string): Promise<void>   // idempotent — removing a non-follow is a no-op
listFollowing(followerId: string): Promise<User[]>                    // ordered by follow created_at ASC
```

`getTimeline` gains an optional filter argument:

```ts
getTimeline(limit: number, before?: TimelineCursor,
            filter?: { followedBy?: string; authorId?: string }): Promise<TimelineEntry[]>
```

- `followedBy: userId` → `WHERE author_id IN (SELECT followed_id FROM follows WHERE follower_id = ?)`
- `authorId: userId` → `WHERE author_id = ?`
- Same `(published_at DESC, id DESC)` ordering and cursor semantics as
  today. Filtering lives in the repo query because pagination does —
  fetch-everything-and-filter is forbidden.
- `getTimelineAfter` (SSE replay) is **unchanged** — replay stays firehose;
  lenses filter client-side (see Live behavior).

## Core API

Writes (bearer-authed, like `POST /posts`):

- `POST /users/:handle/follows` body `{ "handle": "<target>" }` →
  `200 { ok: true }`. Errors: 404 unknown handle (either side), 400 when
  `:handle` is not a local user.
- `DELETE /users/:handle/follows/:target` → `200 { ok: true }`, idempotent
  (deleting a non-follow still 200). 404 only for unknown handles.
- `POST /users/:handle/follows/opml` — OPML import, see below.

Reads (public, like `GET /timeline`):

- `GET /users/:handle/follows` → `{ following: User[] }` (empty for users
  with no follows — including remote users, no special case).
- `GET /timeline?followed_by=<handle>` and `GET /timeline?author=<handle>`
  — the two lenses on the existing route, same `limit`/`cursor` params and
  cursor wire format. `followed_by` and `author` together → 400. Unknown
  handle → 404.
- `GET /users/:handle/following.opml` — OPML export.

## OPML

Both directions use feedsmith (`parseOpml` / `generateOpml`) — already
installed, **no new dependency**.

**Export** — `GET /users/:handle/following.opml`, content-type
`text/xml; charset=utf-8`. One `<outline type="rss" text="<displayName>"
xmlUrl="<url>">` per followed user:

- remote user → their `feedUrl`
- local user → `<PUBLIC_URL>/users/<handle>/feed.xml`; without
  `TEXTCASTER_PUBLIC_URL` the path is emitted relative (`/users/<h>/feed.xml`)
  — a documented degradation, not an error.

**Import** — `POST /users/:handle/follows/opml`, bearer-authed, raw OPML
body, `bodyLimit` **1 MB** (subscription lists outgrow the 64 KB form cap;
still bounded). For each outline carrying an `xmlUrl`:

1. A user with that `feedUrl` already exists → follow it.
2. The URL is one of **this instance's own** local feeds (`PUBLIC_URL` is
   set and the URL equals `<PUBLIC_URL>/users/<h>/feed.xml` for an existing
   local `<h>`) → follow that local user — re-importing your own export
   must not create remote shadows of local users.
3. Unknown → create a remote user via the existing `addRemoteUser` path
   (same validation the manual form gets), then follow it. Handle: slugify
   the outline `text`/`title` (lowercase; every run of characters outside
   `[a-z0-9]` becomes one `-`; trim `-`; truncate to 64; empty → `feed`),
   and on collision suffix `-2`, `-3`, … (retrying through
   `HandleTakenError`).
4. Outline without `xmlUrl`, duplicate `xmlUrl` within the file, or a
   create/follow that errors → count as skipped, keep going.

Response: `200 { followed: n, created: n, skipped: n }`. Import creates
users only — **no synchronous feed fetching**; the poller picks new users
up on its next cycle exactly like manually added remotes (backfill rules,
SSRF guards, and push-in discovery all apply unchanged, for free).

## Web UI

Design-system rules apply (`design-system/textcaster/MASTER.md`); any UI
task invokes `ui-ux-pro-max:ui-ux-pro-max` first, per CLAUDE.md.

- Home (`/`) stays the everyone-firehose — the community square. Untouched.
- `/u/<handle>` — author lens: that user's posts, cursor-paginated.
- `/u/<handle>/following` — the followed-timeline lens for `<handle>`, plus
  the following list with unfollow buttons, a follow form (target handle),
  an OPML import form (file upload), and the export link.
- All of it SSR + plain form POSTs (SvelteKit actions proxying to core with
  the server-held token), usable with JS disabled. Forms carry the follower
  handle explicitly — the same trust model as today's compose form; the
  auth milestone replaces it with the session identity.

## Live behavior

The existing SSE island filters **client-side**; core SSE and replay are
untouched:

- Author lens: drop events where `post.author.id !== page.authorId`.
- Followed lens: drop events where `post.author.id` is not in the follow-id
  set delivered by the page's server `load`.
- Known, accepted staleness: a follow made after page load doesn't join the
  live set until refresh. No-JS behavior is unchanged (refresh).

## Interaction with polling / push

None. Remote users are instance-level entities in the everyone-timeline
whether followed or not; follows never gate ingestion, polling, or push
subscriptions.

## Testing

- Repository contract suite: add/remove idempotency, `listFollowing` order,
  both timeline filters with cursor pagination across page boundaries.
- HTTP: route auth, error codes (400 non-local follower, 400 both filters,
  404s), lens pagination, OPML export shape, import happy path + skip
  accounting + 1 MB cap (413).
- OPML round-trip: export user A's follows from instance 1, import into a
  fresh in-memory instance 2, assert the recreated remote users + follows.
- Web: form-action tests per existing pattern; island filtering unit-tested
  on the event-drop predicate.

## Non-goals

Mute/block, follower counts, "who follows X" (no reverse query until
something needs it), follow suggestions, private lenses (auth milestone),
following remote users' *follows* (their OPML), any change to the SSE
protocol.
