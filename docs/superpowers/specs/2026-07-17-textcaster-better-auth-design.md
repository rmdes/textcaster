# Textcaster — better-auth session layer (anonymous-first) design

Date: 2026-07-17
Status: design approved (brainstorm); spec pending review
Author: Ricardo (rmdes) with Claude Code
Prior art: `2026-07-15-textcaster-design.md` (deferred: IndieAuth/auth);
`2026-07-16-textcaster-following-design.md` explicitly deferred to this
milestone twice: "real auth comes later", "the auth milestone replaces
[form-carried handles] with the session identity".

## What this milestone adds

Sessions, for everyone. better-auth mounts inside core and becomes the
default auth mechanism: every visitor gets an anonymous account the moment
they land (auto `@guest-XXXXX` identity — post and follow immediately, no
form-filled handle ever again), registration with email + password makes the
account permanent, and unregistered accounts are discarded after N idle
days. Adding remote feeds becomes a registered-only action. The shared
bearer token stops authenticating user actions — that closes today's
anyone-can-be-anyone hole, which is the real security payoff.

better-auth is chosen for its plugin ecosystem: magic-link, generic
OAuth/OIDC (the IndieAuth path), and social providers are later milestones
that plug into the same mount point without rearchitecting. This is the one
deliberate new dependency; sessions + credential storage + anonymous
account linking is exactly the security surface we do not hand-roll.

## Architecture

better-auth lives in **core** (approach chosen over web-side auth: core is
the API every future frontend and IndieWeb endpoint talks to — "web is just
one client" — so core must know who's asking; web-side auth would be torn
out the moment Micropub/IndieAuth arrive).

- Mounted on the existing Hono app:
  `app.on(['GET','POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))`.
- Auth tables live in core's existing SQLite database — better-auth accepts
  the `better-sqlite3` `Database` instance core already opens. One file, one
  owner.
- Plugins this milestone: `anonymous` (with `onLinkAccount`) and the
  built-in email/password method. Nothing else. Rate limiting: better-auth's
  built-in limiter, enabled.
- Version: exact-pin the current better-auth release at plan time (probe
  the installed package; do not write API calls from memory).

### Identity model — accounts vs timeline identities

Two tables, two meanings, both survive:

- better-auth's `user` table = **accounts** (credentials, sessions,
  `isAnonymous` flag).
- core's `users` table = **timeline identities** (local people AND remote
  feeds — remote "users" are feeds, not accounts, so the tables are
  genuinely different things).

One new nullable column links them: `users.auth_user_id` (migration, plus
the CLI-generated better-auth tables — see Migrations). Posts and follows
key on the core user's UUID, so registration and rename never move data.

### Lifecycle

**First landing.** Request with no session cookie → web's `hooks.server.ts`
calls core `POST /api/auth/sign-in/anonymous`, relays `Set-Cookie` to the
browser, request proceeds with `locals.user` populated. Core, on anonymous
auth-user creation (better-auth `databaseHooks.user.create.after`, gated on
`isAnonymous`), creates the linked core local user: handle `guest-` + short
random suffix (retry on `HandleTakenError`), display name = handle. By
first paint the visitor has a working identity. All server-side — the no-JS
constraint holds.

Bootstrap is gated to requests that are plausibly a person: only top-level
HTML page loads (request accepts `text/html`; not the feed, SSE, or asset
routes) trigger the anonymous sign-in. Feed readers, WebSub pings, and
crawlers hitting public routes never mint accounts. `ponytail:` ceiling —
Accept-header heuristic only; the rate limit and the idle sweep mop up
whatever slips through.

**Registration (upgrade).** Email + password submitted while anonymously
signed in → better-auth links: `onLinkAccount({ anonymousUser, newUser })`
re-points `users.auth_user_id` to `newUser.id`; better-auth then deletes
the anonymous auth record (its default, kept). Core user row — handle,
display name, posts, follows — untouched. Login from another device with
the same email resumes the same identity.

**Login while anonymous into a DIFFERENT existing account:** the current
guest identity is abandoned (no merging of two identities) and the idle
sweep reclaims it. Pinned: no merge UI, ever, until a real need appears.

**Rename.** `PATCH /me` (session-authed) updates handle and/or display
name any time, anonymous included — set once, never re-type. Uniqueness
enforced as today (`HandleTakenError` → 409 → inline form error). Rename is
one UPDATE because everything keys on UUID.

**Idle cleanup.** Anonymous accounts idle > `TEXTCASTER_ANON_TTL_DAYS`
(default 7) are discarded by a core-side interval sweep (same pattern as
the existing poll timers). Idle = latest better-auth session `updatedAt`
(fallback: auth user `createdAt` when no session rows survive). Cascade:
the guest's posts, follow rows in BOTH directions (others may follow a
guest), the core user row, the auth user + sessions. better-auth session
`expiresIn` is configured ≥ the TTL so a returning tester's cookie outlives
the sweep window. Registered accounts are never swept.

Pinned side-effects, accepted not fixed:
- Deleting a guest's posts can orphan replies from others; threading
  already tolerates missing parents (remote items arrive out of order), so
  orphans degrade to top-level. Not a bug.
- Posts already syndicated out via feeds/WebSub cannot be recalled;
  deletion is local-only.
- A cleared/lost cookie orphans the guest account either way; the sweep is
  the garbage collector for that too.

## Request flow and core API changes

Browsers talk only to the SvelteKit server, as today. The web server
forwards the incoming `Cookie` header on its server-side fetches to core
and relays any `Set-Cookie` back to the browser (register/login/logout and
the anonymous bootstrap are all form actions or hooks doing exactly this).
Core stays unexposed to browsers.

Route changes (breaking, pre-release, no compat shims):

- `POST /posts` — session-authed. Author = session's core user. Body drops
  `handle`/`displayName`. Bearer token no longer accepted.
- `POST /me/follows`, `DELETE /me/follows/:target`,
  `POST /me/follows/opml` — session-authed, replace the
  `POST|DELETE /users/:handle/follows*` write routes (which are removed).
  You can only mutate your own follows now — this is the "lock lenses to
  their owner" the following spec deferred, applied to writes; lens
  *viewing* stays public (they are lenses, not private inboxes).
- `POST /users` — creating a REMOTE user (add feed to monitor) requires a
  session that is **not** anonymous (403 otherwise: a new feed is a real
  polling cost for the whole instance). The ops bearer token is also
  accepted on this route (smoke scripts, seeding) — `session-or-token`
  middleware, this route only.
- `PATCH /me` — rename (above). `GET /me` — the session's core user, for
  the web layout's identity block.
- Reads (`GET /timeline`, lenses, feeds, OPML export, SSE) stay public.
  Unchanged.
- `TEXTCASTER_TOKEN` survives as ops credential only (`POST /users`,
  future admin surface). It authenticates no user action.

## Web UX

Design-system rules apply (`design-system/textcaster/MASTER.md`; UI tasks
invoke `ui-ux-pro-max` first, per CLAUDE.md).

- **Identity block** in the layout header: display name + handle linking to
  your author lens; "Register to keep this account" link when anonymous;
  logout button when registered. The guest handle shown immediately doubles
  as the you-have-an-account discovery cue.
- **Forms lose identity fields.** Compose dialog, reply composer,
  follow/unfollow, OPML import: no more `handle`/`displayName` inputs — the
  session supplies identity server-side.
- **Add-remote-feed gating.** Form renders only for registered users;
  anonymous users see a one-line "Register to add feeds" nudge. The 403 in
  core is the boundary; UI hiding is courtesy.
- **`/register`, `/login`** — plain SSR forms (email + password), SvelteKit
  actions proxying to core's better-auth endpoints, inline `fail()` errors
  (email taken, bad credentials). Register-while-anonymous = the upgrade.
- **`/settings`** — handle + display name edit. Nothing else this
  milestone.
- Every flow is forms + redirects; httpOnly server-set cookie; client
  bundle does not grow. No-JS stays first-class.

## Security

- Session cookie: httpOnly, `SameSite=Lax`, `Secure` in production —
  better-auth defaults, kept.
- CSRF: better-auth's endpoints ship origin-checking; core's user-action
  endpoints are reachable only via the web server's server-side fetches.
- New required config `TEXTCASTER_AUTH_SECRET` (fail-fast at boot, same
  pattern as `TEXTCASTER_TOKEN`). New optional
  `TEXTCASTER_ANON_TTL_DAYS=7`.
- Anonymous-signup flooding: better-auth's per-IP rate limit on the
  anonymous sign-in route + the idle sweep as backstop.
  `ponytail:` ceiling — throttle only; CAPTCHA/turnstile if a real flood
  ever happens.
- The bearer token's demotion to ops-only IS the security fix: user actions
  stop being authenticated by one shared secret plus a self-declared
  handle.

## Migrations

better-auth's CLI generates its table SQL **once at development time**; the
generated SQL is committed as the next `MIGRATIONS` entry (append-only, as
established) together with `ALTER TABLE users ADD COLUMN auth_user_id`.
Runtime has no CLI dependency; tests get the full schema for free. If a
later better-auth upgrade changes its schema, that is a new migration
entry, same rule.

## Testing

- Core: anonymous sign-in creates the linked guest user (and retries handle
  collisions); session-authed post/follow attribute to the session user;
  403 anonymous add-remote-feed; token still works on `POST /users`, and
  ONLY there; `PATCH /me` rename + 409 conflict; `onLinkAccount` re-points
  the link and posts/follows survive registration; sweep deletes the full
  cascade, spares registered and active-anonymous users, and handles the
  no-session-rows fallback.
- Web: hooks bootstrap (no cookie → sign-in called → Set-Cookie relayed);
  form actions read identity from `locals` (no handle fields); add-feed
  gating renders both variants; register/login/settings action tests —
  existing Vitest patterns in both suites.
- Existing core API tests that authenticate user actions with the bearer
  token are UPDATED to session auth (the contract genuinely changed);
  read-route tests stay untouched. Smoke script signs in anonymously and
  exercises the real flow.

## Non-goals

Magic-link, IndieAuth, social providers (later milestones on this same
mount); email verification and password reset; account deletion UI;
merging two identities; avatars/profiles beyond handle + display name;
locking lens *viewing*; any change to feeds, polling, push, or the SSE
protocol; admin UI for the ops token.
