# Better-Auth Session Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mount better-auth inside core, give every visitor a lazily-minted anonymous `@guest-XXXXX` identity on first write, email+password registration to make it permanent, session-authed user actions (bearer token demoted to ops-only), registered-only feed creation, and a TTL sweep for abandoned guests.

**Architecture:** better-auth (1.6.23) runs on core's Hono app at `/api/auth/*`, storing its tables in core's existing SQLite via the SAME raw better-sqlite3 handle. Core's `users` table links to auth accounts through a new `auth_user_id` UNIQUE column; a session middleware resolves (and lazily creates) the core user per request. The web server forwards cookies + an explicit `Origin` header on server-side core fetches and relays `Set-Cookie` back to the browser.

**Tech Stack:** better-auth@1.6.23 (exact pin), better-sqlite3 + Kysely (existing), Hono (existing), SvelteKit form actions (existing), Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-17-textcaster-better-auth-design.md` (rev 3). It wins on ambiguity. Deviations already reconciled at plan time are listed in the self-review notes at the bottom — read them before "fixing" the plan back toward the spec.
- **Exact pin `better-auth@1.6.23`** in `core/package.json` (no `^`). Web gets NO new dependency.
- **One DB handle**: better-auth receives the raw `better-sqlite3` `Database` that `createSqliteRepository` opens. Never `new Database(file)` a second time on the same path.
- **Probed facts (better-auth 1.6.23 installed source — do not re-derive from memory):**
  - `anonymous()` plugin: `onLinkAccount({ anonymousUser, newUser, ctx })` runs BEFORE `deleteUserSessions`/`deleteUser` (`dist/plugins/anonymous/index.mjs:144` vs `:157-158`); a throw in the hook aborts the deletion; deletion is skipped when `disableDeleteAnonymousUser`, same-user, or new-session-still-anonymous. The link after-hook fires on `/sign-in/*` AND `/sign-up/*` whenever an anonymous session exists — so it fires for plain LOGIN too, not just registration.
  - CSRF middleware (`dist/api/middlewares/origin-check.mjs:95-114`): a request carrying a `cookie` header but NO `origin`/`referer` → 403 `MISSING_OR_NULL_ORIGIN`. Server-side fetches MUST set `Origin: <web origin>` and that origin MUST be in `trustedOrigins`.
  - Cookies are host-only by default (no `Domain` attribute) — do NOT enable `advanced.crossSubDomainCookies`.
  - Rate-limit rule shape: `{ window: number; max: number }` under `rateLimit.customRules['<path>']`; `rateLimit.enabled: true` forces it on outside production.
  - Anonymous re-sign-in with a live anon session → 400 (`ANONYMOUS_USERS_CANNOT_SIGN_IN_AGAIN_ANONYMOUSLY`); the web wrapper only mints when no session cookie exists.
  - Schema SQL (Task 1) was CLI-generated at plan time from `betterAuth({ database: sqlite, emailAndPassword: { enabled: true }, plugins: [anonymous()] })`. better-auth does NOT migrate at runtime — core's `MIGRATIONS` is the only schema mechanism.
- New env: `TEXTCASTER_AUTH_SECRET` (required, fail-fast), `TEXTCASTER_WEB_ORIGIN` (default `http://localhost:5173`), `TEXTCASTER_ANON_TTL_DAYS` (default `7`).
- Session-authed routes return 401 without a session, 403 for anonymous where registration is required. `TEXTCASTER_TOKEN` authenticates ONLY `POST /users`.
- Shared checkout with a parallel session: stage EXPLICIT paths only (never `git add -A`). Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- UI work (Task 7) MUST invoke `ui-ux-pro-max:ui-ux-pro-max` first and follow `design-system/textcaster/MASTER.md`. No raw hex; tokens only.
- Existing tests: user-action API tests are UPDATED to session auth (contract change). Read-route, domain, and federation-ingest tests must pass UNMODIFIED unless they create posts/follows through the changed routes.

---

### Task 1: Migration 8 (auth tables + link column) and the shared raw handle

**Files:**
- Modify: `core/package.json` (dependency)
- Modify: `core/src/storage/sqlite.ts` (MIGRATIONS entry, `raw` getter, `UsersTable.auth_user_id`, `rowToUser`, `insertUser`)
- Modify: `core/src/domain/types.ts` (`User.authUserId`, `NewLocalUser.authUserId?`)
- Test: `core/test/migrations.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `repo.raw: Database` (the raw better-sqlite3 handle, for Tasks 3/5); `users.auth_user_id` column + `users_auth_user_idx` UNIQUE index; `User.authUserId: string | null`; `NewLocalUser.authUserId?: string`.

- [ ] **Step 1: Install the dependency**

```bash
cd /home/rmdes/textcaster
npm install -w core --save-exact better-auth@1.6.23
```

Verify: `core/package.json` lists `"better-auth": "1.6.23"`, no `^`.

- [ ] **Step 2: Write the failing tests**

Append to `core/test/migrations.test.ts` (follow the file's existing helper pattern for opening a repo):

```ts
test('migration 8: better-auth tables + users.auth_user_id unique link', async () => {
  const repo = await createSqliteRepository(':memory:')
  const names = repo.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
  for (const t of ['user', 'session', 'account', 'verification']) {
    expect(names.map((n) => n.name)).toContain(t)
  }
  const a = await repo.createLocalUser({ handle: 'a', displayName: 'a', authUserId: 'auth-1' })
  expect(a.authUserId).toBe('auth-1')
  // UNIQUE: a second core user may not claim the same auth user
  await expect(repo.createLocalUser({ handle: 'b', displayName: 'b', authUserId: 'auth-1' })).rejects.toThrow()
  // multiple NULLs are fine (remote feeds never link)
  await repo.createRemoteUser({ handle: 'r1', displayName: 'r1', feedUrl: 'http://e.example/f' })
  await repo.createRemoteUser({ handle: 'r2', displayName: 'r2', feedUrl: 'http://e.example/g' })
})
```

- [ ] **Step 3: Run to verify failure** — `npm test -w core -- migrations`. Expected: FAIL (`raw` undefined / unknown column).

- [ ] **Step 4: Implement**

In `core/src/storage/sqlite.ts`:

(a) Append migration 8 to `MIGRATIONS` (CLI-generated SQL verbatim, plus the link column):

```ts
  [
    // better-auth 1.6.23 tables, generated by `@better-auth/cli generate`
    // (emailAndPassword + anonymous plugin). better-auth never migrates at
    // runtime; this array is the only schema mechanism. A future better-auth
    // schema change = a NEW migration entry, same rule.
    `create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "isAnonymous" integer)`,
    `create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade)`,
    `create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null)`,
    `create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null)`,
    'create index "session_userId_idx" on "session" ("userId")',
    'create index "account_userId_idx" on "account" ("userId")',
    'create index "verification_identifier_idx" on "verification" ("identifier")',
    // accounts <-> timeline identities link (SQLite UNIQUE ignores NULLs,
    // so remote feeds — always NULL — are unaffected)
    'ALTER TABLE users ADD COLUMN auth_user_id text',
    'CREATE UNIQUE INDEX users_auth_user_idx ON users (auth_user_id)',
  ],
```

(b) `UsersTable` gains `auth_user_id: string | null`; `rowToUser` maps `authUserId: r.auth_user_id`; the joined-row helper (`u_*` columns) gains `u_auth_user_id` the same way — grep for every place `UsersTable` fields are selected and add the column.

(c) `insertUser` signature gains `authUserId: string | null` (threaded from `createLocalUser(u)` as `u.authUserId ?? null`; `createRemoteUser` passes `null`). Update its UNIQUE-catch comment: the reachable constraints are now `users.handle` AND `users.auth_user_id`; keep throwing `HandleTakenError` for both — callers that need to distinguish re-check by `getUserByAuthUserId` (Task 3 does).

(d) Expose the handle — store it in the constructor and add:

```ts
  get raw(): Database.Database {
    return this.sqlite
  }
```

(`createSqliteRepository` already has `sqlite` in scope; pass it into the constructor alongside `db`.)

In `core/src/domain/types.ts`: `User` gains `authUserId: string | null`; `NewLocalUser` gains `authUserId?: string`.

- [ ] **Step 5: Run** — `npm test -w core -- migrations` → PASS, then `npm test -w core` → all green (existing suites tolerate the added field; if any snapshot-style assertion on `User` shape fails, extend it with `authUserId: null` — that is the contract growing, not test churn).

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck -w core
git add core/package.json package-lock.json core/src/storage/sqlite.ts core/src/domain/types.ts core/test/migrations.test.ts
git commit -m "core: migration 8 — better-auth tables + auth_user_id link, raw handle exposed

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Repository + service surface for accounts

**Files:**
- Modify: `core/src/storage/sqlite.ts` (three methods)
- Modify: `core/src/domain/repository-contract.ts` + `core/src/domain/repository.ts` (whichever declares the `Repository` type — extend it)
- Modify: `core/src/domain/service.ts` (passthroughs)
- Test: `core/test/sqlite-repository.test.ts` (extend, following the existing contract-test pattern)

**Interfaces:**
- Consumes: Task 1's `auth_user_id` column and types.
- Produces (exact signatures — Tasks 3/4/5 call these):
  - `getUserByAuthUserId(authUserId: string): Promise<User | undefined>`
  - `setAuthUserId(userId: string, authUserId: string): Promise<void>`
  - `updateUserProfile(userId: string, patch: { handle?: string; displayName?: string }): Promise<User>` — throws `HandleTakenError` on conflict
  - Service passthroughs with the same names/signatures.

- [ ] **Step 1: Write the failing tests**

```ts
test('auth link surface: getUserByAuthUserId / setAuthUserId / updateUserProfile', async () => {
  const repo = await createSqliteRepository(':memory:')
  const u = await repo.createLocalUser({ handle: 'guest-abc12', displayName: 'guest-abc12', authUserId: 'anon-1' })
  expect((await repo.getUserByAuthUserId('anon-1'))?.id).toBe(u.id)
  expect(await repo.getUserByAuthUserId('nope')).toBeUndefined()

  await repo.setAuthUserId(u.id, 'perm-1')
  expect((await repo.getUserByAuthUserId('perm-1'))?.id).toBe(u.id)
  expect(await repo.getUserByAuthUserId('anon-1')).toBeUndefined()

  const renamed = await repo.updateUserProfile(u.id, { handle: 'ricardo', displayName: 'Ricardo' })
  expect(renamed.handle).toBe('ricardo')
  expect(renamed.displayName).toBe('Ricardo')
  expect(renamed.authUserId).toBe('perm-1')

  await repo.createLocalUser({ handle: 'taken', displayName: 'taken' })
  await expect(repo.updateUserProfile(u.id, { handle: 'taken' })).rejects.toThrow(HandleTakenError)
})
```

- [ ] **Step 2: Run to verify failure** — `npm test -w core -- sqlite-repository`. Expected: FAIL (methods missing).

- [ ] **Step 3: Implement** (in `SqliteRepository`, matching the file's kysely style):

```ts
  async getUserByAuthUserId(authUserId: string) {
    const r = await this.db.selectFrom('users').selectAll().where('auth_user_id', '=', authUserId).executeTakeFirst()
    return r ? rowToUser(r) : undefined
  }

  async setAuthUserId(userId: string, authUserId: string) {
    await this.db.updateTable('users').set({ auth_user_id: authUserId }).where('id', '=', userId).execute()
  }

  async updateUserProfile(userId: string, patch: { handle?: string; displayName?: string }) {
    try {
      const r = await this.db
        .updateTable('users')
        .set({ ...(patch.handle !== undefined ? { handle: patch.handle } : {}), ...(patch.displayName !== undefined ? { display_name: patch.displayName } : {}) })
        .where('id', '=', userId)
        .returningAll()
        .executeTakeFirstOrThrow()
      return rowToUser(r)
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new HandleTakenError('handle already taken')
      throw err
    }
  }
```

Extend the `Repository` type with the three signatures. In `service.ts`, add passthroughs:

```ts
    getUserByAuthUserId: (authUserId: string) => repo.getUserByAuthUserId(authUserId),
    setAuthUserId: (userId: string, authUserId: string) => repo.setAuthUserId(userId, authUserId),
    updateUserProfile: (userId: string, patch: { handle?: string; displayName?: string }) => repo.updateUserProfile(userId, patch),
    createLocalUser: (u: NewLocalUser) => repo.createLocalUser(u),
```

- [ ] **Step 4: Run + commit**

```bash
npm test -w core -- sqlite-repository && npm run typecheck -w core
git add core/src/storage/sqlite.ts core/src/domain/repository-contract.ts core/src/domain/service.ts core/test/sqlite-repository.test.ts
git commit -m "core: repo/service surface for auth-linked users

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(If the `Repository` type lives elsewhere than `repository-contract.ts`, stage that file instead.)

---

### Task 3: better-auth instance, config, Hono mount, session middleware

**Files:**
- Create: `core/src/auth.ts`
- Modify: `core/src/config.ts` (three new fields)
- Modify: `core/src/api/auth.ts` (session middleware beside `bearerAuth`)
- Modify: `core/src/api/app.ts` (mount only — route conversions are Task 4)
- Modify: `core/src/server.ts` (wire `createAuth`)
- Test: Create `core/test/auth.test.ts`; extend `core/test/config.test.ts`

**Interfaces:**
- Consumes: `repo.raw`, `getUserByAuthUserId`, `setAuthUserId`, `createLocalUser` (Tasks 1–2).
- Produces: `createAuth(deps): Auth` (type `Auth`); `sessionAuth(auth, service)` middleware setting context vars `coreUser: User` and `sessionIsAnonymous: boolean`; `registeredOnly()`; `sessionOrToken(token, auth, service)`; config fields `authSecret: string`, `webOrigin: string`, `anonTtlDays: number`; `createApp` deps gain required `auth: Auth`. Test helper `anonSession(app): Promise<string>` (returns a `Cookie` header value).

- [ ] **Step 1: Config — failing tests first**

Append to `core/test/config.test.ts` (match its existing style of building env objects):

```ts
test('TEXTCASTER_AUTH_SECRET is required', () => {
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't' })).toThrow(/TEXTCASTER_AUTH_SECRET/)
})

test('auth env defaults: webOrigin and anonTtlDays', () => {
  const c = loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's' })
  expect(c.webOrigin).toBe('http://localhost:5173')
  expect(c.anonTtlDays).toBe(7)
  const c2 = loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's', TEXTCASTER_WEB_ORIGIN: 'https://tc.example', TEXTCASTER_ANON_TTL_DAYS: '30' })
  expect(c2.webOrigin).toBe('https://tc.example')
  expect(c2.anonTtlDays).toBe(30)
})
```

NOTE: every existing `loadConfig` test env now needs `TEXTCASTER_AUTH_SECRET` — add it to their env fixtures (this is the required-config contract changing, allowed).

Implement in `config.ts` (same patterns as `token`/`publicUrl`):

```ts
  const authSecret = env.TEXTCASTER_AUTH_SECRET
  if (!authSecret) throw new Error('TEXTCASTER_AUTH_SECRET is required')
  const webOrigin = httpUrl('TEXTCASTER_WEB_ORIGIN', env.TEXTCASTER_WEB_ORIGIN ?? 'http://localhost:5173').replace(/\/+$/, '')
  const anonTtlDays = positiveInt('TEXTCASTER_ANON_TTL_DAYS', env.TEXTCASTER_ANON_TTL_DAYS ?? '7')
```

Add `authSecret`, `webOrigin`, `anonTtlDays` to the `Config` interface and return object.

- [ ] **Step 2: `core/src/auth.ts`**

```ts
import { betterAuth } from 'better-auth'
import { anonymous } from 'better-auth/plugins'
import type Database from 'better-sqlite3'
import type { User } from './domain/types.ts'

export interface AuthDeps {
  sqlite: Database.Database // THE shared handle from repo.raw — never a second connection
  users: {
    getUserByAuthUserId(authUserId: string): Promise<User | undefined>
    setAuthUserId(userId: string, authUserId: string): Promise<void>
  }
  secret: string
  webOrigin: string
  anonTtlDays: number
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
    emailAndPassword: { enabled: true },
    // Cookie must outlive the idle sweep window (spec: expiresIn >= TTL).
    session: { expiresIn: deps.anonTtlDays * 86400 },
    // ponytail: per-IP throttle only; CAPTCHA/turnstile if a real flood ever happens
    rateLimit: { enabled: true, customRules: { '/sign-in/anonymous': { window: 60, max: 10 } } },
    advanced: { cookiePrefix: 'textcaster' },
    plugins: [
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
```

- [ ] **Step 3: Session middleware in `core/src/api/auth.ts`**

```ts
import { randomUUID } from 'node:crypto'
import type { Auth } from '../auth.ts'
import type { User } from '../domain/types.ts'
import { HandleTakenError } from '../domain/types.ts'

export interface UserDirectory {
  getUserByAuthUserId(authUserId: string): Promise<User | undefined>
  createLocalUser(u: { handle: string; displayName: string; authUserId?: string }): Promise<User>
}

// Lazy mint (spec P-1 + direct-registration coverage): the core identity is
// created at first session resolution, whoever the auth user is. One
// mechanism covers anonymous first-write, direct registration, and recovery
// after a failed onLinkAccount re-point.
async function ensureCoreUser(users: UserDirectory, authUserId: string): Promise<User> {
  const existing = await users.getUserByAuthUserId(authUserId)
  if (existing) return existing
  for (let i = 0; i < 50; i++) {
    const handle = `guest-${randomUUID().replace(/-/g, '').slice(0, 6)}`
    try {
      return await users.createLocalUser({ handle, displayName: handle, authUserId })
    } catch (err) {
      if (!(err instanceof HandleTakenError)) throw err
      // UNIQUE(auth_user_id) also maps to HandleTakenError: a concurrent
      // request may have minted for this same session — take theirs.
      const raced = await users.getUserByAuthUserId(authUserId)
      if (raced) return raced
    }
  }
  throw new Error('could not allocate a guest handle')
}

export function sessionAuth(auth: Auth, users: UserDirectory): MiddlewareHandler {
  return async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.json({ error: 'authentication required' }, 401)
    c.set('coreUser', await ensureCoreUser(users, session.user.id))
    c.set('sessionIsAnonymous', (session.user as { isAnonymous?: boolean | null }).isAnonymous === true)
    await next()
  }
}

export function registeredOnly(): MiddlewareHandler {
  return async (c, next) => {
    if (c.get('sessionIsAnonymous')) return c.json({ error: 'registration required' }, 403)
    await next()
  }
}

// POST /users only: ops bearer token OR a registered session.
export function sessionOrToken(token: string, auth: Auth, users: UserDirectory): MiddlewareHandler {
  const viaSession = sessionAuth(auth, users)
  const mustBeRegistered = registeredOnly()
  return async (c, next) => {
    const header = c.req.header('authorization')
    if (header !== undefined) return bearerAuth(token)(c, next)
    return viaSession(c, () => mustBeRegistered(c, next))
  }
}
```

Add the Hono context-var typing via module augmentation at the top of the file:

```ts
declare module 'hono' {
  interface ContextVariableMap {
    coreUser: User
    sessionIsAnonymous: boolean
  }
}
```

- [ ] **Step 4: Mount + wire**

`createApp` deps gain `auth: Auth` (required). In `createApp`, right after `app.get('/health', ...)`:

```ts
  app.on(['GET', 'POST'], '/api/auth/*', (c) => deps.auth.handler(c.req.raw))
```

`server.ts`:

```ts
import { createAuth } from './auth.ts'
// after `const repo = ...`:
const auth = createAuth({ sqlite: repo.raw, users: repo, secret: config.authSecret, webOrigin: config.webOrigin, anonTtlDays: config.anonTtlDays })
// pass `auth` into createApp(...)
```

Every test `makeApp` helper gains `auth` the same way — add a shared helper in each touched test file (or a small `core/test/auth-helper.ts`):

```ts
import type { Hono } from 'hono'
import { createAuth } from '../src/auth.ts'

export function makeAuth(repo: SqliteRepository) {
  return createAuth({ sqlite: repo.raw, users: repo, secret: 'test-secret', webOrigin: 'http://web.test', anonTtlDays: 7 })
}

export async function anonSession(app: Hono): Promise<string> {
  const res = await app.request('/api/auth/sign-in/anonymous', { method: 'POST', headers: { origin: 'http://web.test' } })
  if (res.status !== 200) throw new Error(`anon sign-in failed: ${res.status}`)
  const setCookie = res.headers.get('set-cookie') ?? ''
  return setCookie.split(';')[0] // "textcaster.session_token=..."
}

export async function registeredSession(app: Hono, email: string): Promise<string> {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test' },
    body: JSON.stringify({ email, password: 'password123', name: email }),
  })
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`)
  const setCookie = res.headers.get('set-cookie') ?? ''
  return setCookie.split(';')[0]
}
```

- [ ] **Step 5: Failing tests → green** (`core/test/auth.test.ts`)

```ts
import { test, expect } from 'vitest'
// build app via the same makeApp pattern as api.test.ts, now with makeAuth

test('anonymous sign-in mints a host-only session cookie', async () => {
  const { app } = await makeApp()
  const res = await app.request('/api/auth/sign-in/anonymous', { method: 'POST', headers: { origin: 'http://web.test' } })
  expect(res.status).toBe(200)
  const sc = res.headers.get('set-cookie') ?? ''
  expect(sc).toContain('textcaster.session_token=')
  expect(sc.toLowerCase()).not.toContain('domain=') // host-only (SEC-1)
  expect(sc.toLowerCase()).toContain('httponly')
  expect(sc.toLowerCase()).toContain('samesite=lax')
})

test('cookie without Origin is rejected by better-auth CSRF (probed MISSING_OR_NULL_ORIGIN)', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const res = await app.request('/api/auth/sign-out', { method: 'POST', headers: { cookie } })
  expect(res.status).toBe(403)
})

test('session resolves lazily to a guest core user, stable across requests', async () => {
  const { app, service } = await makeApp()
  const cookie = await anonSession(app)
  // Task 4 gives us GET /me; before that, resolve via the middleware path is
  // not yet routed — test through ensureCoreUser indirectly once /me exists.
  // For THIS task, assert at the service level after a manual resolution:
  // (replace this test with the /me version in Task 4 if written after it)
  expect(cookie).toContain('textcaster.session_token=')
})

test('registration while anonymous re-points the guest core user (onLinkAccount)', async () => {
  const { app, repo } = await makeApp()
  const cookie = await anonSession(app)
  // force the core user into existence the way Task 4 routes will:
  const { sessionAuth } = await import('../src/api/auth.ts') // or export ensureCoreUser for this test
  // simplest: sign up while carrying the anon cookie, then assert the link moved
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test', cookie },
    body: JSON.stringify({ email: 'a@b.example', password: 'password123', name: 'a' }),
  })
  expect(res.status).toBe(200)
})
```

Implementation note for the executor: export `ensureCoreUser` from `api/auth.ts` (it needs direct testing): create the guest BEFORE sign-up via `ensureCoreUser(repo, anonAuthUserId)` — get the anon auth user id from `repo.raw.prepare('SELECT id FROM user WHERE isAnonymous = 1').get()`. After sign-up, assert `repo.getUserByAuthUserId(<new auth id>)` returns the SAME core user id, the guest handle/posts intact, and `SELECT COUNT(*) FROM user WHERE isAnonymous = 1` is 0 (anon auth row deleted). Also add the login-abandon test: register user X in a fresh session, then anon-session + ensureCoreUser + `POST /api/auth/sign-in/email` as X with the anon cookie → the guest core user KEEPS its old (now-dangling) auth_user_id → orphan, reclaimed in Task 5.

Run: `npm test -w core -- auth` → PASS. Full suite: `npm test -w core` → the `makeApp` updates keep everything green (routes unchanged this task).

- [ ] **Step 6: Commit**

```bash
git add core/src/auth.ts core/src/config.ts core/src/api/auth.ts core/src/api/app.ts core/src/server.ts core/test/auth.test.ts core/test/config.test.ts core/test/auth-helper.ts
git commit -m "core: better-auth mounted — anonymous + email/password, session middleware

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Route conversion — session-authed user actions, /me surface, token demotion

**Files:**
- Modify: `core/src/api/app.ts`
- Test: `core/test/api.test.ts`, `core/test/api-follows.test.ts`, `core/test/api-threading.test.ts`, `core/test/federation*.test.ts` (updates), extend `core/test/auth.test.ts`

**Interfaces:**
- Consumes: `sessionAuth`/`registeredOnly`/`sessionOrToken` (Task 3), `updateUserProfile` (Task 2).
- Produces (the new HTTP contract Tasks 6–8 build on):
  - `POST /posts` (session) body `{ content, inReplyTo? }` → 201 `{ post }`
  - `GET /me` (session) → `{ user }`; `PATCH /me` (session) body `{ handle?, displayName? }` → `{ user }` | 409
  - `POST /me/follows` (session) body `{ handle }`; `DELETE /me/follows/:target` (session)
  - `POST /me/follows/opml` (session + registered) — body/response unchanged from the old route
  - `POST /users` (registered session OR ops token) — body/response unchanged
  - Old `/users/:handle/follows*` write routes REMOVED (reads stay).

- [ ] **Step 1: Convert the routes in `app.ts`**

`POST /posts` becomes:

```ts
  app.post('/posts', sessionAuth(deps.auth, deps.users), async (c) => {
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { content, inReplyTo } = body
    if (!isString(content, 1, 100000)) return c.json({ error: 'content invalid' }, 400)
    if (inReplyTo !== undefined && !isString(inReplyTo, 1, 64)) return c.json({ error: 'inReplyTo invalid' }, 400)
    let replyTarget
    if (typeof inReplyTo === 'string') {
      replyTarget = await service.getPost(inReplyTo)
      if (!replyTarget) return c.json({ error: 'unknown post' }, 404)
    }
    const me = c.get('coreUser')
    const post = await service.createLocalPostAs(me.handle, me.displayName, content, replyTarget)
    return c.json({ post }, 201)
  })
```

(`createApp` deps: add `users: UserDirectory` next to `auth` — in `server.ts` and test helpers, pass `repo` for both.)

New `/me` surface:

```ts
  app.get('/me', sessionAuth(deps.auth, deps.users), (c) => c.json({ user: c.get('coreUser'), isAnonymous: c.get('sessionIsAnonymous') }))

  app.patch('/me', sessionAuth(deps.auth, deps.users), async (c) => {
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { handle, displayName } = body
    if (handle !== undefined && !isString(handle, 1, 64)) return c.json({ error: 'handle invalid' }, 400)
    if (displayName !== undefined && !isString(displayName, 1, 200)) return c.json({ error: 'displayName invalid' }, 400)
    try {
      const user = await service.updateUserProfile(c.get('coreUser').id, {
        ...(handle !== undefined ? { handle: handle.toLowerCase() } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
      })
      return c.json({ user })
    } catch (err) {
      if (err instanceof HandleTakenError) return c.json({ error: 'handle already taken' }, 409)
      throw err
    }
  })

  app.post('/me/follows', sessionAuth(deps.auth, deps.users), async (c) => {
    const body = await readJsonBody(c)
    if (!body || !isString(body.handle, 1, 64)) return c.json({ error: 'handle invalid' }, 400)
    const target = await resolveUser(body.handle)
    if (!target) return c.json({ error: 'unknown user' }, 404)
    await service.addFollow(c.get('coreUser'), target)
    return c.json({ ok: true }, 200)
  })

  app.delete('/me/follows/:target', sessionAuth(deps.auth, deps.users), async (c) => {
    const target = await resolveUser(c.req.param('target') ?? '')
    if (!target) return c.json({ error: 'unknown user' }, 404)
    await service.removeFollow(c.get('coreUser').id, target.id)
    return c.json({ ok: true }, 200)
  })

  app.post('/me/follows/opml', sessionAuth(deps.auth, deps.users), registeredOnly(), bodyLimit({ maxSize: 1024 * 1024, onError: rejectOversized }), async (c) => {
    const follower = c.get('coreUser')
    const body = await c.req.text()
    const result = await importFollowingOpml({ /* same deps object as before */ }, follower, body)
    return c.json(result, 200)
  })
```

`POST /users` keeps its handler body verbatim; only the middleware changes:

```ts
  app.post('/users', sessionOrToken(token, deps.auth, deps.users), async (c) => { /* unchanged */ })
```

DELETE the old `POST /users/:handle/follows`, `DELETE /users/:handle/follows/:target`, `POST /users/:handle/follows/opml` routes. `GET /users/:handle/follows`, feeds, OPML export, timeline, SSE: untouched. `HandleTakenError` needs importing in `app.ts`.

- [ ] **Step 2: Update the tests**

Mechanical rule for every failing test: user actions authenticate with `headers: { cookie: await anonSession(app) }` instead of `authorization: Bearer …`, and post bodies drop `handle`/`displayName`. Specifically:
- `api.test.ts`: "requires the bearer token" tests on `/posts` become "requires a session" (expect 401 bare, 201 with cookie). The wrong-token test moves to `POST /users` (still meaningful there).
- `api-follows.test.ts`: rewrite follow-write tests against `/me/follows` (+ keep the read-route tests as-is). The "400 non-local follower" case is now unreachable via HTTP (the session user is always local) — replace it with: anonymous session CAN follow (200), and OPML import as anonymous → 403, as registered → 200.
- `api-threading.test.ts` / `federation*.test.ts`: where they `POST /posts`, mint one `anonSession` per instance and reuse it; where identity matters (multiple authors), use `registeredSession(app, '<distinct email>')` per author, renaming via `PATCH /me` when a test needs a specific handle:

```ts
const cookie = await registeredSession(app, 'alice@test.example')
await app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ handle: 'alice', displayName: 'Alice' }) })
```

Add to `core/test/auth.test.ts`:

```ts
test('user actions 401 without a session; 403 gates for anonymous', async () => {
  const { app } = await makeApp()
  expect((await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"content":"x"}' })).status).toBe(401)
  expect((await app.request('/me')).status).toBe(401)
  const anon = await anonSession(app)
  const addFeed = await app.request('/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: anon },
    body: JSON.stringify({ handle: 'feed1', displayName: 'Feed', feedUrl: 'http://e.example/f.xml' }),
  })
  expect(addFeed.status).toBe(403) // anonymous cannot create feeds
  const reg = await registeredSession(app, 'r@test.example')
  const addFeed2 = await app.request('/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: reg },
    body: JSON.stringify({ handle: 'feed1', displayName: 'Feed', feedUrl: 'http://e.example/f.xml' }),
  })
  expect(addFeed2.status).toBe(201)
})

test('PATCH /me renames; posts and follows survive; 409 on conflict', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{"content":"hello"}' })
  const before = (await (await app.request('/me', { headers: { cookie } })).json()).user
  const renamed = await app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: '{"handle":"ricardo","displayName":"Ricardo"}' })
  expect(renamed.status).toBe(200)
  const timeline = (await (await app.request('/timeline')).json()).timeline
  expect(timeline[0].author.handle).toBe('ricardo')
  expect(timeline[0].author.id).toBe(before.id) // same identity, no data moved
})
```

- [ ] **Step 3: Run** — `npm test -w core` → ALL PASS. `npm run typecheck -w core` → 0 errors.

- [ ] **Step 4: Commit**

```bash
git add core/src/api/app.ts core/test/api.test.ts core/test/api-follows.test.ts core/test/api-threading.test.ts core/test/federation.test.ts core/test/federation-following.test.ts core/test/federation-live.test.ts core/test/federation-threading.test.ts core/test/auth.test.ts
git commit -m "core: user actions are session-authed; /me surface; bearer demoted to POST /users

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Idle sweep

**Files:**
- Modify: `core/src/storage/sqlite.ts` (`sweepAnonymousUsers`)
- Modify: `core/src/server.ts` (hourly loop)
- Test: extend `core/test/auth.test.ts`

**Interfaces:**
- Consumes: `repo.raw`, migration-8 tables.
- Produces: `sweepAnonymousUsers(ttlDays: number): { swept: number }` on `SqliteRepository` (sync raw-SQL internals; NOT on the generic `Repository` contract — auth tables are storage-adapter territory).

- [ ] **Step 1: Failing tests**

```ts
test('sweep reclaims idle anonymous guests (full cascade, one transaction) and orphans; spares the active and the registered', async () => {
  const { app, repo } = await makeApp()
  // idle guest with a post and follows in both directions
  const idle = await anonSession(app)
  await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: idle }, body: '{"content":"guest post"}' })
  const idleUser = (await (await app.request('/me', { headers: { cookie: idle } })).json()).user
  // registered user follows the guest; guest follows them back
  const reg = await registeredSession(app, 'keeper@test.example')
  const regUser = (await (await app.request('/me', { headers: { cookie: reg } })).json()).user
  await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie: reg }, body: JSON.stringify({ handle: idleUser.handle }) })
  await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie: idle }, body: JSON.stringify({ handle: regUser.handle }) })
  // age the idle guest's session + auth user beyond the TTL
  const old = new Date(Date.now() - 8 * 86400_000).toISOString()
  repo.raw.prepare(`UPDATE session SET updatedAt = ? WHERE userId = ?`).run(old, idleUser.authUserId)
  repo.raw.prepare(`UPDATE user SET createdAt = ? WHERE id = ?`).run(old, idleUser.authUserId)
  // an ACTIVE anonymous guest must survive
  const active = await anonSession(app)
  await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: active }, body: '{"content":"still here"}' })

  const { swept } = repo.sweepAnonymousUsers(7)
  expect(swept).toBe(1)
  expect(await repo.getUserByHandle(idleUser.handle)).toBeUndefined()
  expect(repo.raw.prepare(`SELECT COUNT(*) AS n FROM posts WHERE author_id = ?`).get(idleUser.id)).toMatchObject({ n: 0 })
  expect(repo.raw.prepare(`SELECT COUNT(*) AS n FROM follows WHERE follower_id = ? OR followed_id = ?`).get(idleUser.id, idleUser.id)).toMatchObject({ n: 0 })
  expect(repo.raw.prepare(`SELECT COUNT(*) AS n FROM user WHERE id = ?`).get(idleUser.authUserId)).toMatchObject({ n: 0 })
  // survivors
  expect(await repo.getUserByHandle(regUser.handle)).toBeDefined()
  const timeline = (await (await app.request('/timeline')).json()).timeline
  expect(timeline.some((e: { content: string }) => e.content === 'still here')).toBe(true)
})

test('sweep reclaims core users whose auth account is gone (login-abandon orphans)', async () => {
  const { repo } = await makeApp()
  await repo.createLocalUser({ handle: 'guest-orphan', displayName: 'guest-orphan', authUserId: 'deleted-auth-id' })
  const { swept } = repo.sweepAnonymousUsers(7)
  expect(swept).toBe(1)
  expect(await repo.getUserByHandle('guest-orphan')).toBeUndefined()
})
```

- [ ] **Step 2: Run to verify failure**, then implement on `SqliteRepository`:

```ts
  // Idle = latest session update, else auth-user createdAt. Anon guests are
  // few; candidate selection in JS dodges better-auth's date-storage format
  // (new Date() parses ISO strings and epoch numbers alike).
  sweepAnonymousUsers(ttlDays: number): { swept: number } {
    const raw = this.raw
    const cutoff = Date.now() - ttlDays * 86400_000
    const anons = raw.prepare(`SELECT id, createdAt FROM user WHERE isAnonymous = 1`).all() as { id: string; createdAt: string | number }[]
    const latest = new Map(
      (raw.prepare(`SELECT userId, MAX(updatedAt) AS ts FROM session GROUP BY userId`).all() as { userId: string; ts: string | number }[]).map((r) => [r.userId, r.ts]),
    )
    const idle = anons.filter((a) => new Date(latest.get(a.id) ?? a.createdAt).getTime() < cutoff)
    const orphans = raw
      .prepare(`SELECT u.id FROM users u LEFT JOIN user au ON au.id = u.auth_user_id WHERE u.auth_user_id IS NOT NULL AND au.id IS NULL AND u.kind = 'local'`)
      .all() as { id: string }[]

    const coreCascade = (coreUserId: string) => {
      raw.prepare(`DELETE FROM follows WHERE follower_id = ? OR followed_id = ?`).run(coreUserId, coreUserId)
      raw.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?`).run(coreUserId)
      raw.prepare(`DELETE FROM posts WHERE author_id = ?`).run(coreUserId)
      raw.prepare(`DELETE FROM users WHERE id = ?`).run(coreUserId)
    }
    let swept = 0
    raw.transaction(() => {
      for (const a of idle) {
        const core = raw.prepare(`SELECT id FROM users WHERE auth_user_id = ?`).get(a.id) as { id: string } | undefined
        if (core) coreCascade(core.id)
        raw.prepare(`DELETE FROM session WHERE userId = ?`).run(a.id)
        raw.prepare(`DELETE FROM account WHERE userId = ?`).run(a.id)
        raw.prepare(`DELETE FROM user WHERE id = ?`).run(a.id)
        swept++
      }
      for (const o of orphans) {
        coreCascade(o.id)
        swept++
      }
    })()
    return { swept }
  }
```

`server.ts`, after the poll loop (same shape):

```ts
async function sweepLoop() {
  try {
    const { swept } = repo.sweepAnonymousUsers(config.anonTtlDays)
    if (swept > 0) console.log(`swept ${swept} abandoned anonymous account(s)`)
  } catch (err) {
    console.error('anon sweep failed:', err instanceof Error ? err.message : err)
  }
  setTimeout(sweepLoop, 3600_000) // ponytail: fixed hourly cadence; config knob only if an operator ever asks
}
setTimeout(sweepLoop, 3600_000)
```

- [ ] **Step 3: Run + commit**

```bash
npm test -w core && npm run typecheck -w core
git add core/src/storage/sqlite.ts core/src/server.ts core/test/auth.test.ts
git commit -m "core: hourly sweep reclaims idle anonymous accounts and login-abandon orphans

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Web plumbing — cookie forward/relay wrapper, api.ts, mint-then-act form actions

**Files:**
- Create: `web/src/lib/server/session.ts`
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/routes/+page.server.ts`, `web/src/routes/post/[id]/+page.server.ts`, `web/src/routes/u/[handle]/following/+page.server.ts`
- Create: `web/src/routes/+layout.server.ts`
- Test: Create `web/src/lib/server/session.test.ts`; update `web/src/routes/page.actions.test.ts`

**Interfaces:**
- Consumes: core routes from Task 4.
- Produces (Task 7 builds pages on these):
  - `cookieHeader(cookies: Cookies): string | null`
  - `authedFetch(f: typeof fetch, origin: string, cookie: string | null): typeof fetch` — injects `Cookie` + `Origin` (SEC-1: `Origin` is mandatory on cookie-carrying requests, probed 403 otherwise)
  - `relaySetCookies(cookies: Cookies, res: Response): void`
  - `ensureSessionFetch(event: { fetch; cookies; url }): Promise<typeof fetch>` — mint-then-act (NEW-2)
  - `hasSession(cookies: Cookies): boolean`
  - `api.ts`: `createPost(f, { content, inReplyTo? })`, `addFollow(f, target)`, `removeFollow(f, target)`, `importOpml(f, opml)`, `getMe(f): Promise<{ user: TimelineEntry['author']; isAnonymous: boolean } | null>`, `updateProfile(f, { handle?, displayName? })`; `addRemoteUser` keeps its shape; ALL bearer-token headers removed (`CORE_API_TOKEN` is dead in web).
  - Layout `load` returns `{ me: { user, isAnonymous } | null }`.

- [ ] **Step 1: `web/src/lib/server/session.ts`** (tab-indented per web style):

```ts
import type { Cookies } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

export function hasSession(cookies: Cookies): boolean {
	return cookies.getAll().some((c) => c.name.includes('session_token'))
}

export function cookieHeader(cookies: Cookies): string | null {
	const all = cookies.getAll()
	if (all.length === 0) return null
	return all.map((c) => `${c.name}=${c.value}`).join('; ')
}

// SEC-1: core sits on another origin — SvelteKit's fetch forwards nothing.
// Every authed core call carries the browser's cookies AND an explicit
// Origin (better-auth 403s cookie-bearing requests without one, probed).
export function authedFetch(f: typeof fetch, origin: string, cookie: string | null): typeof fetch {
	return (input, init = {}) => {
		const headers = new Headers(init?.headers)
		if (cookie) headers.set('cookie', cookie)
		headers.set('origin', origin)
		return f(input, { ...init, headers })
	}
}

// Relay contract (SEC-1): re-emit better-auth's cookies for the WEB origin —
// httpOnly, SameSite=Lax, Path=/; Secure comes from SvelteKit (auto off on
// localhost, on in production).
export function relaySetCookies(cookies: Cookies, res: Response): void {
	for (const sc of res.headers.getSetCookie()) {
		const [pair, ...attrs] = sc.split(';')
		const eq = pair.indexOf('=')
		if (eq < 1) continue
		const name = pair.slice(0, eq).trim()
		const value = pair.slice(eq + 1).trim()
		const maxAgeRaw = attrs.find((a) => a.trim().toLowerCase().startsWith('max-age'))?.split('=')[1]?.trim()
		const maxAge = maxAgeRaw !== undefined ? Number(maxAgeRaw) : undefined
		if (maxAge !== undefined && maxAge <= 0) {
			cookies.delete(name, { path: '/' })
		} else {
			cookies.set(name, value, { path: '/', httpOnly: true, sameSite: 'lax', ...(maxAge !== undefined ? { maxAge } : {}) })
		}
	}
}

// Mint-then-act (spec NEW-2): no session → sign in anonymously, thread the
// JUST-MINTED cookie onto the follow-up core call in-process, and relay it
// to the browser on this same response.
export async function ensureSessionFetch(event: { fetch: typeof fetch; cookies: Cookies; url: URL }): Promise<typeof fetch> {
	if (hasSession(event.cookies)) return authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
	const res = await event.fetch(`${base()}/api/auth/sign-in/anonymous`, {
		method: 'POST',
		headers: { origin: event.url.origin },
	})
	if (!res.ok) throw new Error(`anonymous sign-in failed (${res.status})`)
	relaySetCookies(event.cookies, res)
	const minted = res.headers.getSetCookie().map((sc) => sc.split(';')[0]).join('; ')
	return authedFetch(event.fetch, event.url.origin, minted)
}
```

- [ ] **Step 2: `api.ts` rework.** Delete `const token = () => ...` and every `authorization` header. `createPost` drops `handle`/`displayName` from its payload type and body; `addFollow`/`removeFollow`/`importOpml` drop their `handle` param and target `/me/follows`, `/me/follows/:target` (encodeURIComponent), `/me/follows/opml`; add:

```ts
export async function getMe(f: typeof fetch): Promise<{ user: TimelineEntry['author']; isAnonymous: boolean } | null> {
	const res = await f(`${base()}/me`)
	if (res.status === 401) return null
	if (!res.ok) throw new Error(await errorMessage(res, 'getMe failed'))
	return (await res.json()) as { user: TimelineEntry['author']; isAnonymous: boolean }
}

export async function updateProfile(f: typeof fetch, patch: { handle?: string; displayName?: string }): Promise<void> {
	const res = await f(`${base()}/me`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(patch),
	})
	if (!res.ok) throw new Error(await errorMessage(res, 'updateProfile failed'))
}
```

- [ ] **Step 3: Actions become sessioned.** `+page.server.ts` compose:

```ts
	compose: async (event) => {
		const form = await event.request.formData()
		const content = String(form.get('content') ?? '').trim()
		if (!content) return fail(400, { error: 'content is required' })
		try {
			const f = await ensureSessionFetch(event)
			await createPost(f, { content })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'createPost failed' })
		}
		throw redirect(303, '/')
	},
	addRemote: async (event) => {
		const form = await event.request.formData()
		const handle = String(form.get('handle') ?? '').trim()
		const displayName = String(form.get('displayName') ?? '').trim() || handle
		const feedUrl = String(form.get('feedUrl') ?? '').trim()
		if (!handle || !feedUrl) return fail(400, { error: 'handle and feedUrl are required' })
		try {
			// no mint: adding feeds is registered-only; a sessionless POST gets core's 401/403
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await addRemoteUser(f, { handle, displayName, feedUrl })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'addRemoteUser failed' })
		}
		throw redirect(303, '/')
	}
```

Reply action (`post/[id]/+page.server.ts`): same shape as compose with `inReplyTo: params.id`, content-only form. Following actions (`u/[handle]/following/+page.server.ts`): `follow`/`unfollow` use `ensureSessionFetch(event)` + `addFollow(f, target)`/`removeFollow(f, target)`; `importOpml` uses `authedFetch` (registered-only, no mint) + `importOpml(f, text)`.

- [ ] **Step 4: `+layout.server.ts`** (identity for the header, NO minting on reads):

```ts
import type { LayoutServerLoad } from './$types'
import { getMe } from '$lib/api'
import { authedFetch, cookieHeader, hasSession } from '$lib/server/session'

export const load: LayoutServerLoad = async ({ fetch, cookies, url }) => {
	if (!hasSession(cookies)) return { me: null }
	try {
		return { me: await getMe(authedFetch(fetch, url.origin, cookieHeader(cookies))) }
	} catch {
		return { me: null }
	}
}
```

- [ ] **Step 5: Tests.** `session.test.ts` unit-tests `relaySetCookies` (value + maxAge relay, delete on Max-Age=0), `authedFetch` (Cookie + Origin injected), `ensureSessionFetch` (mocked fetch: mints once, threads minted cookie onto next call — assert the second request's `cookie` header equals the minted pair). Update `page.actions.test.ts` to the new form shape (no handle fields) with a mocked event (`cookies.getAll` returning a fake session cookie so no mint path runs, plus one test driving the mint path). Add the CSRF pin test:

```ts
import { readFileSync } from 'node:fs'
test('SvelteKit CSRF origin check stays on (SEC-2: it is the real browser-boundary defense)', () => {
	const cfg = readFileSync(new URL('../../svelte.config.js', import.meta.url), 'utf8')
	expect(cfg).not.toMatch(/checkOrigin\s*:\s*false/)
	expect(cfg).not.toMatch(/csrf\s*:\s*false/)
})
```

(Place the relative URL correctly for the test file's location.)

- [ ] **Step 6: Run + commit**

```bash
npm test -w web && cd web && npm run check && cd ..
git add web/src/lib/server/session.ts web/src/lib/server/session.test.ts web/src/lib/api.ts web/src/routes/+layout.server.ts web/src/routes/+page.server.ts "web/src/routes/post/[id]/+page.server.ts" "web/src/routes/u/[handle]/following/+page.server.ts" web/src/routes/page.actions.test.ts
git commit -m "web: session plumbing — cookie forward/relay, mint-then-act actions, identity load

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Web UI — identity block, register/login/settings, gating

**REQUIRED FIRST:** invoke `ui-ux-pro-max:ui-ux-pro-max`; follow `design-system/textcaster/MASTER.md` (tokens only, no raw hex, no-JS first-class, Libre Bodoni / Public Sans).

**Files:**
- Modify: `web/src/routes/+layout.svelte` (identity block in the header)
- Create: `web/src/routes/register/+page.svelte`, `web/src/routes/register/+page.server.ts`
- Create: `web/src/routes/login/+page.svelte`, `web/src/routes/login/+page.server.ts`
- Create: `web/src/routes/settings/+page.svelte`, `web/src/routes/settings/+page.server.ts`
- Modify: `web/src/routes/+page.svelte` (compose form drops handle/displayName inputs; add-feed gating), `web/src/routes/post/[id]/+page.svelte` (reply form drops handle input), `web/src/routes/u/[handle]/following/+page.svelte` (OPML gating)
- Modify: `web/src/app.css` (identity-block styles from existing tokens)
- Test: Create `web/src/routes/auth.actions.test.ts`

**Interfaces:**
- Consumes: `data.me` from the layout load; `ensureSessionFetch`/`authedFetch`/`relaySetCookies` (Task 6); core better-auth endpoints.
- Produces: the user-facing auth UX. No new exports.

- [ ] **Step 1: Identity block** in `+layout.svelte` header — three states from `data.me`:
  - `null` → "Browsing as a guest — post or follow to get an identity." + links to `/login` and `/register`.
  - `me.isAnonymous` → `@{me.user.handle}` linking to `/u/{me.user.handle}` + a prominent "Register to keep this account" link to `/register` + `/settings` link.
  - registered → display name + `@handle` link, `/settings` link, and a logout form button (`method="POST" action="/login?/logout"`).

- [ ] **Step 2: Auth pages.** `/register/+page.server.ts`:

```ts
import type { Actions } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { cookieHeader, relaySetCookies } from '$lib/server/session'
import { env } from '$env/dynamic/private'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

export const actions = {
	register: async ({ request, fetch, cookies, url }) => {
		const form = await request.formData()
		const email = String(form.get('email') ?? '').trim()
		const password = String(form.get('password') ?? '')
		if (!email || password.length < 8) return fail(400, { error: 'email and a password of at least 8 characters are required' })
		const cookie = cookieHeader(cookies)
		// register-while-anonymous IS the upgrade: the anon cookie rides along,
		// better-auth links (onLinkAccount re-points the core user server-side)
		const res = await fetch(`${base()}/api/auth/sign-up/email`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: url.origin, ...(cookie ? { cookie } : {}) },
			body: JSON.stringify({ email, password, name: email.split('@')[0] }),
		})
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { message?: string }
			return fail(res.status === 422 || res.status === 400 ? 400 : 500, { error: body.message ?? 'registration failed' })
		}
		relaySetCookies(cookies, res)
		throw redirect(303, '/')
	}
} satisfies Actions
```

`/login/+page.server.ts`: `login` action mirrors it against `/api/auth/sign-in/email` (body `{ email, password }`), plus:

```ts
	logout: async ({ fetch, cookies, url }) => {
		const cookie = cookieHeader(cookies)
		if (cookie) {
			const res = await fetch(`${base()}/api/auth/sign-out`, { method: 'POST', headers: { origin: url.origin, cookie } })
			relaySetCookies(cookies, res)
		}
		throw redirect(303, '/')
	}
```

`/settings/+page.server.ts`: `load` redirects to `/` when `!hasSession(cookies)`; `save` action reads `handle`/`displayName` from the form, calls `updateProfile(authedFetch(fetch, url.origin, cookieHeader(cookies)), patch)`, maps the 409 message to `fail(409, { error: 'handle already taken' })`, redirects to `/settings` on success. Pages are plain SSR forms with the existing form/error markup patterns (`fail` → inline error paragraph), styled from existing tokens.

- [ ] **Step 3: Form/gating edits.** Compose dialog + reply composer: delete the `handle`/`displayName` inputs (and their `required` handling). Home add-feed form and following-page OPML form: wrap in `{#if data.me && !data.me.isAnonymous}` … `{:else}` one-line "Register to add feeds." nudge linking `/register` `{/if}`. Follow/unfollow buttons now act as the session user — on `/u/[handle]/following` label the section so it is clear whose follows the buttons change (the visitor's own).

- [ ] **Step 4: Tests** (`auth.actions.test.ts`, same mocked-event pattern as `page.actions.test.ts`): register action relays cookies and redirects; register failure surfaces the better-auth message; logout calls sign-out with cookie+origin and redirects; settings save maps 409 → inline error.

- [ ] **Step 5: Visual verification** (Playwright MCP against the dev servers): land sessionless → guest nudge in header; compose a post → guest handle appears in header; register → header shows permanent identity; rename in /settings → timeline attribution updates; add-feed form hidden for anonymous, visible after registering. Both themes, and once with JS disabled (forms must still work).

- [ ] **Step 6: Run + commit**

```bash
npm test -w web && cd web && npm run check && cd ..
git add web/src/routes/+layout.svelte web/src/routes/register web/src/routes/login web/src/routes/settings web/src/routes/+page.svelte "web/src/routes/post/[id]/+page.svelte" "web/src/routes/u/[handle]/following/+page.svelte" web/src/app.css web/src/routes/auth.actions.test.ts
git commit -m "web: auth UX — identity block, register/login/settings, registered-only gating

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Smoke, docs, demotion audit

**Files:**
- Modify: `core/src/smoke.ts` (+ its test if `core/test/smoke.test.ts` asserts flows)
- Modify: `docs/superpowers/documentation/RUNNING.md`
- Verify-only: bearer-token audit

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Smoke exercises the real flow.** Read `core/src/smoke.ts`; replace its bearer-token post/follow calls with: `POST /api/auth/sign-in/anonymous` (capture cookie) → `POST /posts` with cookie → `GET /me` → keep any `POST /users` seeding on the ops token (that is now the token's one legitimate job). Update `core/test/smoke.test.ts` accordingly.

- [ ] **Step 2: RUNNING.md.** Document: `TEXTCASTER_AUTH_SECRET` (required; generate with `openssl rand -hex 32`), `TEXTCASTER_WEB_ORIGIN` (must match the web app's public origin or every action 403s), `TEXTCASTER_ANON_TTL_DAYS`; the visitor flow (act first, `@guest-XXXXX` minted, register to keep it, idle guests swept); add-feed/OPML require registration; `TEXTCASTER_TOKEN` is ops-only now; web no longer needs `CORE_API_TOKEN` (remove it from any example env).

- [ ] **Step 3: Demotion audit**

```bash
grep -rn "bearerAuth" core/src           # expect: definition + POST /users only (sessionOrToken)
grep -rn "CORE_API_TOKEN\|authorization" web/src   # expect: no hits
npm test -w core && npm test -w web
```

- [ ] **Step 4: End-to-end.** Start both servers per RUNNING.md; with curl: sessionless `POST /posts` → 401; anonymous sign-in → cookie; post with cookie + `Origin` → 201; `POST /users` with anon cookie → 403, with ops token → 201. Then the Task 7 Step 5 browser pass if not already done against live servers.

- [ ] **Step 5: Commit**

```bash
git add core/src/smoke.ts core/test/smoke.test.ts docs/superpowers/documentation/RUNNING.md
git commit -m "core+docs: smoke over sessions, auth env docs, bearer demotion audit

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Plan self-review notes (done at write time)

- Spec coverage: mount + shared handle + disabled runtime migration (T1/T3), identity link UNIQUE+index (T1), repo surface (T2 — `deleteUserCascade` folded into `sweepAnonymousUsers`, see deviations), cookie mechanics incl. both failure modes (T3 tests, T6 wrapper), CSRF at SvelteKit + trustedOrigins + explicit Origin (T3/T6, pin test in T6), lazy mint (T3 `ensureCoreUser`, T6 `ensureSessionFetch`), onLinkAccount re-point + login-abandon (T3), route conversion + OPML/feed gating on the capability (T4), rename (T2/T4), sweep incl. orphans + one transaction (T5), web UX + no-JS (T6/T7), smoke/docs/audit (T8), token demotion (T4/T8).
- Deviations from spec rev 3, deliberate and probe-driven:
  1. **Core-user creation moved from `databaseHooks.user.create.after` to lazy `ensureCoreUser` at session resolution.** Probed: the create-hook approach either misses direct registrations (gated on `isAnonymous`) or double-mints during account linking (ungated). One resolution-time mechanism covers anonymous first-write, direct registration, and failed-re-point recovery. Spec's observable contract (first write mints a linked guest) is unchanged.
  2. **`deleteUserCascade` is not a standalone repo method**; the cascade lives inside `sweepAnonymousUsers` (raw sync SQL — kysely's async API cannot run inside a better-sqlite3 sync transaction, and the sweep must be one transaction across auth + core tables). Account-deletion UI is a spec non-goal; when it arrives, extract the cascade then.
  3. **Sweep gains the orphan-reclaim query** (core users whose `auth_user_id` no longer resolves): the probed login-abandon path deletes the anon AUTH row immediately, so idle-based selection alone would never reclaim those guests. This implements the spec's "abandoned … the idle sweep reclaims it" for how the abandonment actually manifests.
- Type consistency checked: `repo.raw`, `getUserByAuthUserId`, `setAuthUserId`, `updateUserProfile`, `createLocalUser({ authUserId })`, `sweepAnonymousUsers(ttlDays) → { swept }`, `createAuth(deps) → Auth`, `sessionAuth(auth, users)`, `anonSession/registeredSession` helpers, `ensureSessionFetch/authedFetch/cookieHeader/relaySetCookies/hasSession`, `getMe/updateProfile` are used with the same names and shapes across tasks.
- Task 3 Step 5's middle test is a placeholder-risk: it asserts only the cookie shape until `/me` exists — Task 4's `/me` tests supersede it; the executor should fold it forward rather than leave a weak assertion behind.
