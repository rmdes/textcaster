import { betterAuth } from 'better-auth'
import { anonymous, magicLink } from 'better-auth/plugins'
import type Database from 'better-sqlite3'
import type { User } from './domain/types.ts'
import type { Mailer } from './mail.ts'

export interface AuthDeps {
  sqlite: Database.Database // THE shared handle from repo.raw — never a second connection
  users: {
    getUserByAuthUserId(authUserId: string): Promise<User | undefined>
    setAuthUserId(userId: string, authUserId: string): Promise<void>
  }
  secret: string
  webOrigin: string
  anonTtlDays: number
  mailer: Mailer | null
}

export function createAuth(deps: AuthDeps) {
  return betterAuth({
    database: deps.sqlite,
    secret: deps.secret,
    // baseURL is the user-facing origin (the web app). Requests reach this
    // handler proxied by the web server; routing matches on the default
    // basePath /api/auth regardless of host. Anonymous temp-email domains
    // derive from this URL. Redirect flows are unused (JSON responses only).
    baseURL: deps.webOrigin,
    trustedOrigins: [deps.webOrigin],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true, // hard verification (spec decision)
      sendResetPassword: async ({ user, url }) => {
        if (!deps.mailer) throw new Error('email is not configured on this instance')
        await deps.mailer.send(user.email, 'Reset your Textcaster password', `Reset your password: ${url}`)
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        if (!deps.mailer) throw new Error('email is not configured on this instance')
        await deps.mailer.send(user.email, 'Verify your Textcaster email', `Verify your email: ${url}`)
      },
    },
    // 4x the sweep TTL: the browser cookie must outlive the idle window even
    // though getSession's rolling refresh isn't relayed yet — relaying it via
    // /me is the real fix (recorded follow-up)
    session: { expiresIn: deps.anonTtlDays * 4 * 86400 },
    // ponytail: per-IP throttle only; CAPTCHA/turnstile if a real flood ever happens
    rateLimit: { enabled: true, customRules: { '/sign-in/anonymous': { window: 60, max: 10 }, '/sign-in/magic-link': { window: 60, max: 5 } } },
    // disableOriginCheck defaults to true under NODE_ENV=test (better-auth's
    // isTest() shortcut) — pin it off so CSRF/origin checks are real in our
    // own (vitest) test suite too, not just in production.
    advanced: { cookiePrefix: 'textcaster', disableOriginCheck: false },
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          if (!deps.mailer) throw new Error('email is not configured on this instance')
          await deps.mailer.send(email, 'Your Textcaster login link', `Log in: ${url}`)
        },
      }),
      anonymous({
        // Fires on ANY sign-in/sign-up while an anonymous session exists
        // (probed) — registration upgrade AND plain login both land here.
        async onLinkAccount({ anonymousUser, newUser }) {
          const guest = await deps.users.getUserByAuthUserId(anonymousUser.user.id)
          if (!guest) return // guest never acted — nothing to carry over
          const existing = await deps.users.getUserByAuthUserId(newUser.user.id)
          if (existing) return // login into an established account: abandon the guest, the sweep reclaims it
          // Fresh registration: re-point the guest's core row. A throw here
          // aborts better-auth's anon-user deletion (probed ordering) — the
          // guest identity survives a failed re-point.
          await deps.users.setAuthUserId(guest.id, newUser.user.id)
        },
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
