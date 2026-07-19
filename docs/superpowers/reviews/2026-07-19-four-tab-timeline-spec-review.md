# SP2 four-tab timeline spec — clean-context review findings

**Spec:** `docs/superpowers/specs/2026-07-19-four-tab-timeline-design.md` (rev 0, `1e32c3c`)
**Reviewers:** parallel clean-context correctness reviewer + ponytail-review, 2026-07-19.
**Disposition:** all findings folded as **rev 1** unless noted.

## Correctness review

Verified correct (no action): the five joined select sites + shared-mapper fix
covers all client-facing entries including SSE replay; every live emit site
(local create/edit, ingest, push-in) already carries `author.feedType`;
`listFollowing` returns all follows with `feed_type`; `await parent()` works
from `+page.server.ts`; edit-SSE-through-lens is safe (an edit matches the same
lens its post did; wedge subtrees never receive edit overlays today); proposed
test files exist; MASTER.md tokens/patterns as specced.

1. **Important — Personal river excludes the viewer's own posts, and compose
   lands there.** No auto self-follow exists; `followed_by` filters strictly by
   follow edges, and `?/compose` redirects to `/` → Personal default for
   registered users → your own new post is invisible. **Folded:** core
   `followedBy` branch becomes self-inclusive (`author_id = follower OR …`);
   client `followIds` includes own id. Semantic side-effect (accepted):
   `/u/:handle/following` now also shows the owner's own posts.
2. **Important — form actions drop `?tab`.** Named-action URLs (`?/compose`)
   replace the query string, and success redirects go to bare `/` — every
   action from a non-default tab lands the user back on their default.
   **Folded:** actions preserve the active tab (form action URL
   `?tab=<tab>&/name`, redirects `/?tab=<tab>…`).
3. **Minor — `?feed` flash copy false on Personal.** `addRemote` follows
   nothing, so "its posts appear in your timeline" is wrong on the Personal
   tab. **Folded:** `addRemote` success redirects to `/?tab=public&feed=…`
   (copy true there); full form repoint stays SP3.
4. **Minor — fail-soft `me` + core-down under-specified.** **Folded:** the
   load's catch branch returns the resolved tab + empty `followIds` so the tab
   bar renders with correct active state; the guest-CTA concern dissolved with
   ponytail finding 1.
5. **Minor — `JoinedRow` new field should be `FeedType | null`** (no cast
   needed; `UsersTable.feed_type` is already typed). **Folded.**
6. **Minor — line-ref nit** (`listFollowing` is :196-206). **Folded.**

## Ponytail review

Confirmed lean (keep): uniform 5-site core change, one-line lens kinds,
always-explicit-tab pagination.

1. **Guest-on-personal special path → delete.** Skip-fetch branch, flag,
   login-CTA empty state, dedicated test — replaced by the existing
   invalid-tab rule: guest + `personal` resolves to `public`. **Folded.**
2. **`getFollowing` on every personal load → first page only.** `followIds`
   only feeds the live lens; `LiveTimeline` mounts only on `isFirstPage`.
   **Folded.**
3. **Tab-bar styling respecced from scratch → copy `.admin-nav`**
   (`web/src/routes/admin/+layout.svelte:35-59`, same aria-current + accent
   underline pattern); keep only MASTER.md deltas (focus ring, fixed height).
   **Folded.**
4. **Six spy-based load tests → one pure tab-resolution helper** tested
   directly; drop the older-link test (template interpolation). **Folded.**
5. **Guest-skip-fetch test** — falls away with 1. **Folded.**
