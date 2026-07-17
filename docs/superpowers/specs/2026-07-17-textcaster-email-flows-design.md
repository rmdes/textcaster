# Textcaster — email flows design (verification, magic link, reset)

Date: 2026-07-17
Status: design approved (brainstorm); spec pending review
Author: Ricardo (rmdes) with Claude Code
Basis: better-auth milestone (4c88ed6..5cea86d): better-auth 1.6.23 mounted
on core at `/api/auth/*`, anonymous guests + email/password, session-authed
actions, web cookie relay (`session.ts`), `/register` `/login` `/settings`
pages. Today `emailAndPassword` works with NO mail anywhere: any string
registers instantly, `emailVerified` is never set or checked, magic link
does not exist, and password reset is IMPOSSIBLE (no `sendResetPassword`) —
a forgotten password permanently loses the account.

## Decisions (user-confirmed)

- **Hard verification**: `requireEmailVerification: true` — an unverified
  email+password account cannot sign in. "Otherwise it's not worth it."
- **Magic link is the friendly primary flow**; password remains available.
- **Password reset ships in the same slice** (it is the account-loss fix).
- **New dependency: `nodemailer`** (core only; approved) — no stdlib SMTP
  client exists and hand-rolled SMTP is the wrong cleverness.
- Deployment posture: production SMTP comes from Cloudron's mail addon;
  dev/self-host uses Mailpit. A future `textcaster-deploy` repo (docker,
  Mailpit, Cloudron manifest) is OUT of this spec's scope; this slice only
  has to be env-configurable so that repo can wire it.
- IndieAuth: later, fresh session; it mounts as another better-auth
  provider on this same foundation.

## The mailer seam

`core/src/mail.ts`:

```ts
export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>
}
export function createMailer(smtpUrl: string | null, from: string): Mailer | null
```

- `createMailer(null, …)` → `null`: auth still boots; flows that need mail
  fail HONESTLY (better-auth surfaces the thrown error from the send
  callback; the web page shows "email is not configured on this instance").
  No silent pretend-success.
- Config (`config.ts`): `TEXTCASTER_SMTP_URL` (optional; e.g.
  `smtp://localhost:1025` for Mailpit — no TLS/auth needed there;
  `smtps://user:pass@host:465` shapes must work for Cloudron),
  `TEXTCASTER_MAIL_FROM` (default `textcaster@<host of PUBLIC_URL or
  webOrigin>`).
- Plain-text emails only (v1): subject + a URL. No templates, no HTML —
  YAGNI, and text mail survives every client.
- All emails' links point at the WEB origin (`webOrigin`), which proxies
  `/api/auth/*` to core — same path every browser flow already takes.

## better-auth wiring (core/src/auth.ts)

1. `emailAndPassword` gains:
   - `requireEmailVerification: true`
   - `sendResetPassword: ({ user, url }) => mailer.send(user.email,
     'Reset your Textcaster password', url)` (exact callback signature
     probed at plan time against installed 1.6.23 — never from memory)
2. `emailVerification`: `sendVerificationEmail` → mailer; auto-send on
   sign-up (better-auth option name probed at plan time;
   `sendOnSignUp`-shaped).
3. `magicLink()` plugin from `better-auth/plugins`:
   - `sendMagicLink: ({ email, url }) => mailer.send(...)`
   - Probe and PIN at plan time: whether a consumed magic link sets
     `emailVerified` (expected yes — the click is ownership proof). If it
     does not, the plan adds the flag in the plugin's callback per
     better-auth's documented option; the invariant is: after a magic-link
     login, the account behaves as verified.
   - Rate-limit rule for `/sign-in/magic-link` alongside the existing
     anonymous rule (same `{ window, max }` shape, e.g. 60s/5 — plan pins).
4. When `mailer === null`, the callbacks throw a clear DomainError-shaped
   message so better-auth returns an actionable failure.

## The guest-upgrade interaction (the one subtle path)

Registering WHILE anonymous must not strand the guest session:

- Sign-up-while-anonymous still creates the account and sends the
  verification mail; the visitor REMAINS in their anonymous session (their
  guest identity keeps working) until the verification link is clicked.
- The `onLinkAccount` re-point (guest core row → new auth user) must
  happen such that the guest's posts/follows survive the upgrade exactly as
  today. WHEN it fires relative to hard verification is a MANDATORY
  plan-time probe of installed better-auth (the auth milestone was burned
  and then saved by exactly this class of hook-ordering question). The
  invariant to pin with a test, whatever the ordering: guest posts before
  registration + verification are attributed to the same core user after
  verification completes and the user signs in.
- Magic-link-while-anonymous follows the same invariant (link click =
  login = onLinkAccount fires per the probed "fires on ANY sign-in/sign-up
  with an anon session" behavior).

## Web surface

- `/register`: on success, show "check your inbox to verify" state instead
  of redirecting as-if-logged-in; unverified login attempts surface
  better-auth's error as "verify your email first (check spam / resend)".
  A resend-verification action if better-auth exposes one (probe; if not
  exposed, re-triggering signup's send path or omitting resend in v1 —
  plan decides from the probe, omission is acceptable v1).
- `/login`: gains the magic-link form (email only, "Email me a login
  link") beside the password form; success state = "check your inbox".
- `/forgot` (new): email form → reset mail; `/reset` landing (better-auth
  serves token validation; the web page posts the new password to the
  better-auth endpoint with cookie/origin relay like every other auth
  call).
- Identity bar: unverified registered users (if such a state is reachable
  under hard verification — probe) show a "verify your email" nudge.
- All pages: plain SSR forms, existing `.auth-form`/`fail`-error patterns,
  tokens only. UI work invokes ui-ux-pro-max per project rule.

## What does NOT change

- Anonymous guest flow (act-first, lazy mint, TTL sweep) — untouched.
- Session middleware, `/me` surface, route auth — untouched.
- The bearer token's ops-only role — untouched.
- No new tables expected: better-auth's `verification` table (migration 8)
  already exists for these tokens. If the magic-link plugin's CLI schema
  demands more, that is a NEW migration entry, appended — probed at plan
  time, never assumed.

## Testing

- Mailer: unit tests with a capturing fake (`send` recorded); one nodemailer
  transport-construction test (smtp:// and smtps:// URL shapes parse).
- Auth flows (core, supertest-style like auth.test.ts): register →
  verification mail captured, link URL parses, login BLOCKED before
  verification (401/403 per better-auth), works after GET-ing the link;
  magic link → mail captured, consuming the link yields a session AND the
  verified invariant; reset → mail captured, new password works, old one
  does not; every flow with `mailer === null` → honest failure, no
  account-state corruption.
- Guest-upgrade invariant test (per the probe's pinned ordering).
- Web action tests: register shows check-inbox state; magic-link request
  action relays cookies; forgot/reset actions map errors inline.
- Human click-check: full loop against local Mailpit (register → Mailpit →
  verify → login; magic link; reset), both themes.
- RUNNING.md: TEXTCASTER_SMTP_URL / TEXTCASTER_MAIL_FROM, Mailpit
  one-liner (`docker run -p 1025:1025 -p 8025:8025 axllent/mailpit`), the
  hard-verification behavior, Cloudron note (mail addon env → SMTP URL).

## Sequencing

1. Mailer seam + config + tests.
2. better-auth wiring (verification, magic link, reset) + core flow tests
   incl. the guest-upgrade invariant (probes first).
3. Web pages/actions + RUNNING.md.
4. Mailpit click-check.
