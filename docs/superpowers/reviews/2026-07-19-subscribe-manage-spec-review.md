# SP3 subscribe & manage — spec review (rev 0 → rev 1)

Spec: `docs/superpowers/specs/2026-07-19-subscribe-manage-design.md`
Reviewers: clean-context correctness (13 findings, file:line-verified) +
ponytail (8 cuts). All dispositions folded as rev 1.

## Correctness findings

- **F1 Important — local-feed-URL shadow.** `subscribeByUrl` has no local-URL
  resolve (`getRemoteUserByFeedUrl` matches remote only); pasting a
  same-instance feed URL (even your own) mints a remote clone that re-ingests
  duplicate posts. **Folded:** fifth ride-along — `localHandleForUrl` resolve
  (OPML Case-2 pattern) before the remote lookup.
- **F2 Important — case-sensitive owner check.** Handles are stored/lowered
  lowercase; `isOwner`/lens compares on raw `params.handle` would demote the
  owner on a mixed-case URL. **Folded:** load lowercases the param.
- **F3 Important — backfill guard vs discovery rewrite.** R1's `updateFeedUrl`
  breaks `display_name === feed_url` forever for the most common flow (pasting
  a page URL). **Folded:** backfill runs before `updateFeedUrl`.
- **F4 Important — title not parsed anywhere; fat-ping path.**
  `parseFeedWithMeta` discards feed titles; function names corrected
  (`ingestRemoteUser`/`ingestViaDiscovery`); fat-ping feeds heal on the
  every-10th-tick full poll. **Folded:** title threading specified; fat-ping
  explicitly accepted out of scope.
- **F5 Important — "at source" overstated.** OPML Case-1 still mints vestigial
  instance follows. **Folded (with ponytail thinking):** the guard moved to
  `service.addFollow` itself — one central guard covers reuse, OPML Case-1,
  the re-resolve winner, and direct `POST /me/follows`.
- F6 Minor line refs (`updateFeedUrl` is sqlite.ts:108) — fixed.
- F7 Minor `subscribe.test.ts:77` strict `toEqual` breaks on `created` — called
  out in §7.
- F8 Minor OPML re-resolve needs `ImportDeps.getRemoteUserByFeedUrl` +
  `subCount++` + instance-winner handling — all specified.
- F9 Minor three deleted `addRemote` action tests — called out in §7.
- F10 Minor cap bypass via uncapped `POST /me/follows` — documented as
  known/accepted in §6, gating deferred.
- F11 Minor OPML silent cap-skips — import-result copy gains a reason hint.
- F12 Minor tab-override coherence — confirmed intentional, asymmetry noted in §3.
- F13 Minor guest/anon ambiguity in viewerFollowIds — dissolved (feature cut).

## Ponytail cuts (all folded)

1. Lens `ownerHandle` extension → one inline disjunct in the following page's
   `onPost`; `lens.ts` untouched.
2. `viewerFollowIds` fetch + branch deleted — `addFollow` is idempotent and
   the instance guard no-ops instance rows; always render Follow.
3. Duplicate `?/subscribe` actions → the following-page form posts cross-route
   to `/?/subscribe` (one action, one error rail).
4. feedType badge on every row → `instance` badge only.
5. Two bespoke flash strings → one ("Now following @handle."), redirect
   ternary keeps `personal`/`federated` landing.
6. Per-button "Follow as you" title/aria → the existing auth-note suffices.
7. §6 "open details" forward references → inlined where used.
8. Tests for cut features pruned (lens unit test, viewerFollowIds load test,
   duplicate action suite, admin-settings load test).

Net effect: rev 1 closes five real design holes and sheds ~100 implementation
lines relative to rev 0.

## Parallel-session review of rev 1 (dda1d0a)

Independent pass on the rev-1 folds themselves, grounded in source (three
finders; all quotes verified). **Verdict: rev 2 needed — S1–S3 are
design-level holes in the folded fixes; S4/S6/S7 are honesty-scoping lines;
S8 is a count fix.** The web design (§§3-6) verified almost entirely clean.

### S1 — Critical: `subscribeByUrl` never calls the "central" guard

`subscribeByUrl`'s reuse, race-winner, and create paths call
**`repo.addFollow` directly** (service.ts:164, 176, 179 — the comment even
says "call repo directly"), bypassing `service.addFollow` entirely. The rev-1
claim "one guard covers every path: … subscribeByUrl reuse" is false — a user
pasting an instance feed URL still mints the vestigial instance follow via
the repo call. **Fix:** spec must state the mechanism: either route those
three call sites through the guarded service method, or hoist the
`feedType === 'instance'` check to a tiny shared helper both use. "One guard"
stands only if every minting path actually goes through it.

### S2 — `addFollow` returns void — the per-path count semantics are unimplementable

OPML Case-1 (opml.ts:106) runs `await deps.addFollow(…); followed++;
subCount++` unconditionally, and the planned Case-3 winner-follow has the
same shape. With a silent no-op guard, callers cannot distinguish
minted-vs-skipped, so "count instance winner as `skipped`" and Case-1's
no-op semantics cannot be branched. **Fix:** `addFollow` (and the guard
helper) returns a boolean (`minted`); OPML counts from it. One line in §1,
but load-bearing for every counter the spec specifies.

### S3 — Self-follow: the headline "even your own URL" case is unspecified and currently mints a self-edge

There is no self-follow guard anywhere — repository-contract.ts:276 documents
"self-follow is allowed" and asserts a self-edge lands in `listFollowing`.
So F1's own headline flow (pasting YOUR feed URL) resolves to you →
`addFollow(you, you)` → your own handle appears in your subscriptions list,
and with SP2's self-inclusive personal river your posts are double-sourced.
**Fix (specify one):** recommend — local-URL resolve that lands on the
subscriber themselves skips the follow and returns
`{ user: you, followed: false, created: false }`, flash stays honest via the
`followed:false → federated` redirect… or better a dedicated flash ("That's
your own feed"). Cap impact is nil either way (verified:
`countRemoteSubscriptions` excludes locals), but the spec must pick.

### S4 — Local-URL resolve is inert without `TEXTCASTER_PUBLIC_URL`

`localHandleForUrl` returns null immediately when `publicUrl` is unset
(opml.ts:70; config.ts:47-48), and dev/docker compose sets no public URL. In
those deployments F1's fix silently never matches and the remote-shadow bug
survives (same dead branch in OPML Case-2 today). Live Cloudron instances set
it, so prod is fine. **Fix:** one spec line accepting the limitation
("local-URL resolve requires publicUrl; without it the shadow-mint persists —
dev-only exposure") or extend matching to the request host. Don't leave it
implicit.

### S6 — "Pre-existing URL-named rows heal too" is over-broad

The F3 ordering fix saves rows whose first successful *post-ship* poll does
the backfill. But a row whose `feed_url` was already rewritten by discovery
*pre-ship* has `display_name` = input URL ≠ `feed_url` = discovered URL, and
every later poll takes the main parse path (never re-enters discovery) — the
equality guard fails forever; those rows are stranded. **Fix:** scope the
claim to "URL-named rows never discovery-rewritten"; stranded rows are a
cosmetic backlog item (or a one-time heal query — YAGNI).

### S7 — The h-feed/mf2 discovery branch has no title to backfill from

`discoverFeed` returns `{feedUrl, hentries}` only; the h-feed sub-branch
(ingest.ts:275-278) never calls `parseFeedWithMeta`, so no feed-level title
exists there and no backfill can fire — "all four format branches" covers the
parse path, not the mf2 path. h-feed-resolved rows keep URL display names.
**Fix:** one scoping line in §1 (mf2 path out of scope; card/author-name
harvesting is backlog).

### S8 — Four `addRemote` tests, not three

`page.actions.test.ts` has FOUR addRemote tests (lines 66, 74, 81, 107); the
spec twice says "three." Deleting three leaves a test referencing the removed
action → red typecheck/suite. **Fix:** say four.

### Verified clean (for the record)

Web §§3-6 held up wholesale: current addRemote panel/action/redirect quoted
as specced; `?tab={data.tab}&/subscribe` matches the shipped SP2 pattern;
flash mechanics (`?feed=` → `data.addedFeed`) with no test asserting the old
copy; cross-route no-JS fallback behavior matches the spec's accepted
wording (no `use:enhance` on those forms, so no applyAction concern);
following-page premises exact (raw un-lowercased `params.handle` today,
auth-note at :54, lens omits owner + includes instances, `.badge-kind`
exists); admin layout has three tabs + 404-hide gate; core
`GET/PATCH /admin/settings` shapes match; `addRemoteUser` correctly kept for
/admin/feeds. Core side: cap counter excludes locals AND instances
(sqlite.ts:164-173); `getRemoteUserByFeedUrl` real; subscribeByUrl's sole
consumer is the route; route is 201-unconditional today and
`subscriptions-api.test.ts`'s `[200,201]` pairs tolerate the split (strict
201s are all create-path); `subscribe.test.ts:77` is genuinely strict (spec
already flags the amend); OPML deps wiring point (app.ts:274-286) is as
specced. Backfill side: all four parse branches expose a title feedsmith
really provides (Atom optional — covered by the non-empty guard); the
equality-guard seeding scope is exactly right (OPML with-text and admin
handle-seeded rows correctly never match); fat-ping skip + every-10th-tick
full poll verified; `updateFeedUrl` at sqlite.ts:108 is the right template;
the F3 compare-point (ingest.ts:265, before the :269 rewrite) is
implementable as specced.
