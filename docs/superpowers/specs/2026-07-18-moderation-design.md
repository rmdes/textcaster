# Moderation (hard removal) — Design

**Status:** design
**Date:** 2026-07-18
**Milestone:** Instance admin & authorization (sub-project 3 of 4)

## Context

SP1 (authz foundation), SP2 (feed management), and SP4 (broader admin UI) are
done and deployed. SP3 is the moderation sub-project the authorization-foundation
spec scoped as *"admin removing users/posts, banning"* — the removal actions an
instance admin needs against local abuse.

**Scope decision (settled in brainstorming):** the founding-design non-goal is
specifically *"moderation-**labeling** infrastructure"* (labels, flags, reports,
content-warnings). Removal is a different thing and is in scope. SP3 is therefore
**hard removal only** — no suspend/ban flag, no soft-hide, no report/label system.
Deletion is the moderation lever.

**Data-model facts this rests on** (verified):
- `deleteUserCascade(id)` (`sqlite.ts`) already deletes a user's posts, follows,
  push-subscriptions, and the `users` row in one transaction — shared with
  `sweepAnonymousUsers`.
- `sweepAnonymousUsers` shows the **full** local-account teardown: after the core
  cascade it also deletes the better-auth `session`, `account`, and `user` rows.
- No `hidden`/`suspended`/`status` column exists on `posts` or `users`, and the
  timeline queries carry no visibility filter — consistent with hard-removal (we
  delete rows, we don't flag them).
- Admin is email-derived from the `TEXTCASTER_ADMIN_EMAIL` env allowlist
  (`config.adminEmails`) — **not** stored on the account.

## Goal

An instance admin can permanently remove a local account (and all its content) or
an individual local post, from the admin surface — no new schema, no labeling.

## Design

### Core: two admin-gated removal endpoints (both `authed` + `requireAdmin()`)

These live under `/admin/*` (admin-session-gated, **not** the ops token) and leave
SP2's `DELETE /users/:handle` (remote-feed removal, 409-on-local) **unchanged** —
SP3 does not reverse that boundary, it adds a separate local-account path.

#### `DELETE /admin/users/:handle` — delete a local account

Deletes a **local** account and everything it owns via
**`service.deleteLocalAccount(handle)`** — the service owns the lookup + local-kind
check + orchestration, mirroring `removeRemoteFeed`'s shape (no new repo-level
wrapper). It calls two repo primitives:
1. `deleteUserCascade(user.id)` (existing) — posts, follows, push-subscriptions,
   `users` row.
2. **`deleteAuthRows(authUserId)`** — a small repo method **extracted from
   `sweepAnonymousUsers`** (which currently inlines the `session`/`account`/`user`
   deletes) so the better-auth teardown lives in one place, reused by both the
   sweep and this path. (A local account always has an `auth_user_id`; skip if null.)

- **404** if the handle is unknown.
- **409** (`{ error: 'not a local account' }`) if the handle resolves to a
  **remote** feed — those are removed via `DELETE /users/:handle` (SP2).
- **200** `{ ok: true }` on success.
- **No admin-delete guard** (settled): an admin may delete *any* local account,
  including one whose email is in `adminEmails` (e.g. to remove a stale or rotated
  admin, or their own account). Deleting the account does **not** remove the email
  from `TEXTCASTER_ADMIN_EMAIL` — that env allowlist is config-owned, so
  re-registering that email would regain admin. This is intended: the account row
  is gone; the allowlist is a separate, deliberate env edit.
- **Cascade semantics** match SP2's feed removal: a *local reply* to one of the
  deleted account's posts survives (orphaned) because `in_reply_to_post_id` is not
  a foreign key.

#### `DELETE /admin/posts/:id` — delete a single local post

Deletes one **local** post via **`service.deletePost(id)`** (lookup + local-kind
check + discriminated result, same shape as `removeRemoteFeed`), calling a new thin
`repo.deletePost(id)` primitive.
- **200** `{ ok: true }` on success.
- **404** if the id is unknown.
- **409** (`{ error: 'not a local post' }`) if the id resolves to a **remote**
  post — a deleted remote post just re-ingests on the next poll, so remote content
  is moderated by removing the *feed* (SP2), not the post. Restricting to local
  keeps the action durable and honest.
- A local reply to the deleted post survives (orphaned), same as above.

### Web: actions on the existing admin surface (SP4)

- **`/admin/users`** — a **"Delete account"** form action per **local** account
  (remote feeds already have their remove on `/admin/feeds`). It POSTs to a
  `deleteUser` action that calls `DELETE /admin/users/:handle`, forwarding the
  admin session. **Confirmation:** `use:enhance` + a JS `confirm()` ("Delete
  @handle and all their posts? This can't be undone.") that degrades to an
  explicit-labeled submit with no JS. `fail()` on error, message shown inline.
- **Local posts** — an admin-only **"Remove"** affordance on each **local** post
  in the timeline and the post-detail view, gated on `data.me.isAdmin` and
  `entry.source === 'local'`. It POSTs to a `deletePost` action → `DELETE
  /admin/posts/:id`; the post disappears on the following load (live prepend/SSE
  is unaffected — a deleted post simply isn't re-fetched).

**UI convention (required):** the new affordances MUST be built via the
`ui-ux-pro-max:ui-ux-pro-max` skill and follow `design-system/textcaster/MASTER.md`
(tokens/typography/spacing; no raw hex — `--color-*`; `--color-destructive` for the
destructive actions), and consult the relevant `svelte-skills`
(`sveltekit-data-flow` for the actions, `svelte-runes` for state). Destructive
buttons are clearly labeled and confirmation-guarded; no `{@html}` introduced.

## Error handling

- Both endpoints: `requireAdmin()` → non-admin session (registered or anon) 403,
  no session 401; unknown target 404; wrong-kind target 409 (users) / 404 (posts).
- Web actions: non-admin never sees the affordances (the `/admin` layout gate +
  the `isAdmin` check on the post button); a non-admin who force-POSTs an action
  hits core's `requireAdmin` 403, caught into `fail()` — defense in depth, as SP2
  established.
- Deleting your own account ends your session; the next request is unauthenticated
  and the UI falls back to the logged-out state. Acceptable — it's the admin's
  deliberate choice.

## Out of scope

- **Suspend / ban / hide flags** and any **soft** (reversible) moderation — this is
  hard removal only.
- **Report / label / flag / content-warning** infrastructure — the founding non-goal.
- **Remote-post moderation** beyond feed removal (a deleted remote post re-ingests).
- **Editing the `TEXTCASTER_ADMIN_EMAIL` allowlist** from the UI — it's env config.

## Testing

**Core (in-process Hono, existing style):**
- `deleteLocalAccount`: seeds a registered local user (real lazy-mint via an authed
  request) with a post; after delete, the `users` row, its posts, and the
  better-auth `user`/`session`/`account` rows are all gone; a local reply to the
  deleted post survives (orphaned).
- `DELETE /admin/users/:handle`: 200 on a local account (**including one whose
  email is in `adminEmails`** — no guard); 409 on a remote feed; 404 unknown.
- `deletePost` / `DELETE /admin/posts/:id`: 200 removes a local post; 409 on a
  remote post's id; 404 on an unknown id.
- Gate matrix on both endpoints: admin 200, non-admin registered 403, anon session
  403, no session 401.

**Web:** the `/admin/users` delete action is admin-gated and calls the right core
endpoint with the forwarded session; the post "Remove" affordance renders only for
an admin on a local post; both actions `fail()` gracefully on a core error.

## Revisions

**Rev 1 (2026-07-18)** — folded a ponytail review of this spec (2 cuts accepted):
- **No `repo.deleteLocalAccount` wrapper** — `service.deleteLocalAccount(handle)`
  owns lookup + kind-check + orchestration (mirroring `removeRemoteFeed`); the repo
  stays primitives-only. Same for `service.deletePost(id)` over `repo.deletePost(id)`.
- **Extract `repo.deleteAuthRows(authUserId)`** from `sweepAnonymousUsers`'s inline
  `session`/`account`/`user` teardown, reused by both the sweep and local-account
  deletion — one place, not a re-typed block.

Reviewer confirmed the rest lean: the two separate endpoints are justified (SP2's
`DELETE /users/:handle` is ops-token-eligible + remote-only by design — folding local
deletion in would branch permitted-target on auth-mechanism), `repo.deletePost` is
genuinely new + minimal, the web "Remove" affordance reuses SP4's already-plumbed
`data.me.isAdmin` + the existing `entry.source` field (no new fetch), and the
`confirm()` + no-JS fallback is proportionate for the app's first irreversible action.
