# Spec review — Docker Compose (dev + self-host) (2026-07-17)

## Re-review — rev 2 (c909c1b): CLEAN, ready to plan

Verified against the `944310f..c909c1b` diff — all three findings landed
correctly:
- **F-1** — `/api/auth/*` removed from `@core`; the matcher is now feeds +
  federation callbacks only, and `/api/auth/*` explicitly falls through to
  `web:3000` (the Origin-injecting proxy path, matching dev).
- **F-2** — `backend` network now includes `caddy`, so `reverse_proxy core:8787`
  resolves; core keeps no published host ports (isolation preserved).
- **F-3** — prod web env gains `ADDRESS_HEADER=X-Forwarded-For` + `XFF_DEPTH=1`
  beside `ORIGIN`.
- Regexes `^`-anchored; `/peers` confirmed internal with rationale.

No new issues from the fixes (caddy-on-backend adds no host exposure; core still
host-isolated). Ready to write the plan.

---

## Original review — rev 1 (944310f)

Grounded in the current core route list (`api/app.ts`), the web auth proxy
(`web/src/routes/api/auth/[...path]/+server.ts`), the feed-URL shapes
(`feed.ts`), and the spec's Caddyfile + networks. Focus per the author's ask:
the Caddy public/internal boundary.

**Verdict: NOT ready to plan — two prod-breaking issues in the routing/topology
(F-1, F-2), one missing prod env var (F-3).** The allowlist's *feed + federation*
entries are correct; the finicky adapter-node/dev-volume mechanics are sound. The
two blockers are both about how the front door reaches core.

## F-1 — HIGH: `/api/auth/*` must route to **web**, not core — the allowlist sends it to the wrong backend

The auth milestone deliberately serves the entire auth surface through a web
proxy, `web/src/routes/api/auth/[...path]/+server.ts`. Its own header comment
(a prior final-review fix, C1) is explicit: *"better-auth's baseURL is the WEB
origin, so every emailed link — verify, magic-link, password-reset — points at
`<web>/api/auth/*`. The web app must actually serve those."* That proxy does
three things a direct browser→core hit cannot:

- **Injects `Origin`** (`headers.set('origin', url.origin)`) because
  "better-auth 403s cookie-bearing requests without it." A user clicking an
  email verify/magic/reset link performs a **native GET navigation, which sends
  no `Origin` header** — so hitting core directly (Caddy→core) means better-auth
  sees a cookie-bearing request with no Origin and **403s the exact link-clicks
  the email milestone ships**.
- **Relays `Set-Cookie`** so a magic-link GET actually lands a session.
- **Relays the 302** (`redirect: 'manual'`) to the callbackURL.

The Caddy `@core` block lists `path /api/auth/*` → `reverse_proxy core:8787`,
which intercepts before the catch-all and **bypasses this proxy entirely**. In
prod, email links break; the reviewed proxy becomes dead code; and the auth
request path **diverges from dev** (dev has no Caddy, so browsers go
web→proxy→core), so nothing tested in dev exercises the prod path. All the
form-POST flows (register/login/magic-request/sign-out/anonymous) already reach
core **server-side** over `CORE_API_URL` on the backend network — they never
needed public `/api/auth/*` either.

**Fix:** remove `/api/auth/*` from `@core`; let it fall through to
`reverse_proxy web:3000`, where the existing proxy serves it. Less Caddy config,
restores dev/prod parity, keeps the reviewed cookie/Origin/redirect handling.

## F-2 — HIGH: Caddy and core share no network — every public core path 502s

Spec line 112: `frontend` = (caddy, web, mailpit); `backend` = (web, core,
mailpit); **"core ONLY on backend."** But Caddy `reverse_proxy core:8787`
requires Caddy to resolve and reach `core` — and Caddy is on **frontend only**,
core on **backend only**, so they share no Docker network. Caddy can't reach
core → the feed and federation paths it proxies to `core:8787` all **502 in
prod**. (Mailpit works — it's on frontend with caddy; web works — frontend.)

**Fix:** put **caddy on the backend network too** (or core on frontend). Cleaner
is caddy on both: it then reaches core (backend) for the public paths and
web/mailpit (frontend), while core keeps **no published ports** and stays
off the host — the isolation that actually matters. "core only on backend" is
the over-tight statement that breaks it.

## F-3 — MED: adapter-node needs `ADDRESS_HEADER` behind Caddy

The web auth proxy calls `getClientAddress()` (`+server.ts:22`) to set
`x-forwarded-for` for better-auth's rate limiter. Under adapter-node behind a
reverse proxy, `getClientAddress()` needs `ADDRESS_HEADER=X-Forwarded-For` (and
`XFF_DEPTH=1` for the single Caddy hop) or it throws / returns Caddy's IP —
which also collapses per-IP rate limiting to one bucket. The spec sets `ORIGIN`
(correct for CSRF) but not `ADDRESS_HEADER`. Add both to the prod web env. This
becomes load-bearing precisely once F-1 routes `/api/auth/*` through web.

## Allowlist — the rest is correct

Cross-checked `@core` against the live route list:
- **Correctly public → core:** `/users/rss.xml`, `/users/<h>/feed.(xml|json)`,
  `/users/<h>/following.opml`, `/post/<id>/comments.xml` (feeds are advertised on
  `/users/*` per `feed.ts:33-37`, consumed by external readers — direct-to-core
  is right, no cookie/CSRF surface); `/websub/callback/*`, `/rsscloud/notify`,
  `/rsscloud/pleaseNotify`, `/hub` (federation callbacks from external
  servers — must be publicly reachable; token/HMAC-authed, not cookie-authed).
- **Correctly internal (excluded):** `/posts`, `/me*`, `/timeline`,
  `/timeline/stream`, `POST /users`, `/users/<h>/follows` (JSON; the public
  equivalent is `.opml`), `/post/<id>/thread` (public equivalent is
  `comments.xml`), `/health`.
- **Confirm intent:** `/peers` is listed internal — if Textcasting peer
  discovery is meant to be publicly crawlable, it belongs in `@core`; if it's
  only the web app's data, internal is right. One-line decision.
- **Minor hardening:** the `path_regexp`s are end-anchored (`$`) but not
  start-anchored (`^`), so `/x/users/a/feed.xml` would also match. Core 404s such
  paths (no leak), but anchor with `^` for precision.

## The other two flagged parts
- **adapter-node swap (#2):** correct — `adapter-auto` produces nothing runnable;
  `ORIGIN` is set for CSRF. Just add F-3's `ADDRESS_HEADER`.
- **Dev live-reload (#3):** the named-`node_modules`-volume-over-bind-mount
  pattern is right (container's Linux `better-sqlite3` wins). Two finicky notes
  for the smoke: it assumes full workspace hoisting (one root volume works
  because `better-sqlite3` hoists to root — verify no nested workspace
  `node_modules` carries a native build); and `npm ci` on every `up` re-wipes the
  volume (correct but slow — an init-once guard is a fair optimization).

## Ponytail
Appropriately lean: Compose over any orchestrator, SQLite (no separate DB
service), glibc base to dodge a native compile, plain-text env, one justified
dependency. Nothing to cut — the issues above are correctness, not excess.

## What to change before planning
F-1 (route `/api/auth/*` → web, not core), F-2 (caddy on the backend network),
F-3 (`ADDRESS_HEADER`/`XFF_DEPTH` in prod web env). Confirm `/peers` intent;
anchor the regexes. The feed/federation allowlist, the adapter-node swap, the
base-image/native-module reasoning, and the dev-volume pattern are sound.
