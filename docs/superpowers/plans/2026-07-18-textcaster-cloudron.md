# Textcaster Cloudron Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package Textcaster as a single Cloudron app (core + web + internal nginx) that installs and runs a full instance behind Cloudron's HTTPS, using SQLite/localstorage + sendmail.

**Architecture:** One container runs nginx on the manifest `httpPort`, reproducing the current Caddy public-path split: seven public feed/federation paths proxy to `core` (127.0.0.1:8787), everything else (UI, `/api/auth`, `/stream`) to `web` (127.0.0.1:3000). `start.sh` generates persistent secrets, maps `CLOUDRON_*` env, and supervises the three processes; the container exits (and Cloudron restarts it) if any dies.

**Tech Stack:** Cloudron (`cloudron/base:5.0.0`, manifestVersion 2, addons localstorage + sendmail), Node 22.x (native type stripping, adapter-node), nginx, better-sqlite3 (SQLite in `/app/data`), bash.

**Spec:** `docs/superpowers/specs/2026-07-18-textcaster-cloudron-design.md` (rev 1).

## Global Constraints

- **Single app; core and web never published.** nginx on `httpPort 8000` is the only listener; core stays 127.0.0.1:8787, web 127.0.0.1:3000.
- **nginx path split is the security boundary** — it must match the `Caddyfile` `@core` matcher exactly (start-anchored, single-segment; `*` never crosses `/`). Public → core: `/users/rss.xml`, `/users/*/feed.xml`, `/users/*/feed.json`, `/users/*/following.opml`, `/post/*/comments.xml`, `/websub/callback/*`, `/rsscloud/notify`, `/rsscloud/pleaseNotify`, `/hub`. Everything else → web.
- **`/api/auth/*` MUST route to web, never core** (emailed-link GETs carry no Origin; web's proxy injects it).
- **Data store is SQLite on localstorage** (`/app/data/textcaster.db`). No mongodb/postgres/redis/ldap/oidc addons.
- **Secrets `TEXTCASTER_AUTH_SECRET` and `TEXTCASTER_TOKEN` are generated once and persisted** in `/app/data/config/` — never regenerated (regenerating the auth secret invalidates every session). Both are **required** by core at boot (`core/src/config.ts:38,63` throw if unset).
- **`/app/code` and `/app/pkg` are read-only at runtime; only `/app/data`, `/run`, `/tmp` are writable.** Symlinks into `/app/data` are created in the Dockerfile, never `start.sh`.
- **`NODE_ENV=production` is set AFTER `npm ci` + build**, never before (else devDeps needed for the web build don't install).
- **Node runs as `cloudron:cloudron` via `gosu`, never root.**
- **Never fabricate the base-image SHA** — re-verify the current `cloudron/base` tag+digest from `git.cloudron.io/packages/` at build time.
- **Packaging lives in `cloudron/`** in the monorepo. `.dockerignore` already excludes `**/.env`, `**/data`, `*.db`, `web/build`, `docs`, `.superpowers` — do not weaken it.
- **Never `git add -A`** (shared checkout). Stage explicit paths. Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: WAL journal mode in core (backup-consistency foundation)

Cloudron backs up `/app/data` at the filesystem level; a naive copy of a non-WAL SQLite file can catch a partial transaction. WAL mode keeps the main DB file consistent and, with its `-wal`/`-shm` siblings (also under `/app/data`), restores cleanly. This is the one core code change the package needs.

**Files:**
- Modify: `core/src/storage/sqlite.ts:565-567` (the `openDatabase`/factory site where `new Database(filename)` runs)
- Test: `core/test/sqlite-wal.test.ts` (create)

**Interfaces:**
- Consumes: the existing exported factory in `core/src/storage/sqlite.ts` that opens a DB from a filename and returns the repository/`Kysely` handle. (Confirm its exact exported name by reading the file — it is the function containing `const sqlite = new Database(filename)` at line ~565.)
- Produces: same factory, now issuing `PRAGMA journal_mode = WAL` immediately after open. No signature change.

- [ ] **Step 1: Write the failing test**

Create `core/test/sqlite-wal.test.ts`. It opens a **file-backed** DB (not `:memory:`, which can't use WAL) through the real factory and asserts the journal mode.

```ts
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'

// createSqliteRepository is async: `export async function createSqliteRepository
// (filename: string): Promise<SqliteRepository>` — must be awaited.
test('file-backed DB runs in WAL journal mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-wal-'))
  const file = join(dir, 'test.db')
  try {
    await createSqliteRepository(file) // opens + migrates; sets WAL
    const check = new Database(file, { readonly: true })
    const mode = check.pragma('journal_mode', { simple: true })
    check.close()
    expect(mode).toBe('wal')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w core -- sqlite-wal`
Expected: FAIL — `expected 'delete' to be 'wal'` (WAL not set yet).

- [ ] **Step 3: Add the pragma**

In `core/src/storage/sqlite.ts`, immediately after `const sqlite = new Database(filename)` and before `migrate(sqlite)`:

```ts
  const sqlite = new Database(filename)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  migrate(sqlite)
```

(WAL is a no-op for `:memory:` DBs — SQLite keeps `memory` mode — so existing in-memory tests are unaffected.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w core -- sqlite-wal`
Expected: PASS.

- [ ] **Step 5: Run the full core suite (WAL must not regress anything)**

Run: `npm test -w core`
Expected: all pass (in-memory tests still `memory` mode; file tests now WAL).

- [ ] **Step 6: Commit**

```bash
git add core/src/storage/sqlite.ts core/test/sqlite-wal.test.ts
git commit -m "core: open SQLite in WAL mode (Cloudron backup consistency)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: CloudronManifest.json + logo

**Files:**
- Create: `cloudron/CloudronManifest.json`
- Create: `cloudron/logo.png` (256×256, rasterized from `web/src/lib/assets/favicon.svg`)
- Test: `cloudron/test/manifest.test.mjs` (create)

**Interfaces:**
- Produces: `cloudron/CloudronManifest.json` with `httpPort: 8000`, addons `localstorage` + `sendmail`, `healthCheckPath: "/"`; `cloudron/logo.png` referenced as `file://logo.png`.

- [ ] **Step 1: Write the failing test**

Create `cloudron/test/manifest.test.mjs` (plain Node, run with `node --test`):

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('..', import.meta.url))
const m = JSON.parse(readFileSync(dir + 'CloudronManifest.json', 'utf8'))

test('manifest has the required Cloudron fields', () => {
  assert.equal(m.manifestVersion, 2)
  assert.equal(m.httpPort, 8000)
  assert.equal(m.healthCheckPath, '/')
  assert.ok(m.addons.localstorage, 'localstorage addon')
  assert.ok(m.addons.sendmail, 'sendmail addon')
  assert.ok(!m.addons.mongodb && !m.addons.postgresql, 'no db addon')
  assert.match(m.id, /^[a-z0-9.]+$/, 'reverse-DNS id')
  assert.ok(m.version && m.title && m.author)
})

test('logo.png exists and is non-empty', () => {
  const s = statSync(dir + 'logo.png')
  assert.ok(s.size > 0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test cloudron/test/manifest.test.mjs`
Expected: FAIL — manifest/logo do not exist yet.

- [ ] **Step 3: Create the manifest**

Create `cloudron/CloudronManifest.json`:

```json
{
  "id": "net.textcaster.app",
  "title": "Textcaster",
  "author": "Ricardo Mendes",
  "description": "A feeds-native social timeline — posts, replies, and conversations travel as RSS.",
  "tagline": "A feeds-native social timeline",
  "version": "0.1.0",
  "healthCheckPath": "/",
  "httpPort": 8000,
  "addons": {
    "localstorage": {},
    "sendmail": {}
  },
  "manifestVersion": 2,
  "minBoxVersion": "8.0.0",
  "memoryLimit": 1073741824,
  "website": "https://github.com/rmdes/textcaster",
  "contactEmail": "hello@rmendes.net",
  "icon": "file://logo.png",
  "tags": ["rss", "indieweb", "social", "feeds", "textcasting"]
}
```

- [ ] **Step 4: Generate the logo**

Rasterize the existing favicon to a 256×256 PNG. Try `rsvg-convert`, then ImageMagick as fallback:

```bash
mkdir -p cloudron
if command -v rsvg-convert >/dev/null; then
  rsvg-convert -w 256 -h 256 web/src/lib/assets/favicon.svg -o cloudron/logo.png
else
  convert -background none -resize 256x256 web/src/lib/assets/favicon.svg cloudron/logo.png
fi
file cloudron/logo.png   # expect: PNG image data, 256 x 256
```

If neither tool is installed, install one: `sudo apt-get install -y librsvg2-bin` (provides `rsvg-convert`).

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test cloudron/test/manifest.test.mjs`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add cloudron/CloudronManifest.json cloudron/logo.png cloudron/test/manifest.test.mjs
git commit -m "cloudron: manifest (localstorage+sendmail, httpPort 8000) + logo

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: nginx.conf + proxy_params + path-parity test

The security boundary. `proxy_params` holds the shared header block; `nginx.conf` routes the seven public paths to core and everything else to web, with a non-buffering `/stream` block for SSE.

**Files:**
- Create: `cloudron/nginx.conf`
- Create: `cloudron/proxy_params`
- Create: `cloudron/test/routing-test.sh` (integration test with stub upstreams)

**Interfaces:**
- Consumes: the public-path list from Global Constraints (the `Caddyfile` `@core` set).
- Produces: `cloudron/nginx.conf` listening on 8000, proxying to `127.0.0.1:8787` (core) and `127.0.0.1:3000` (web); `cloudron/proxy_params` included per location.

- [ ] **Step 1: Write the failing test**

Create `cloudron/test/routing-test.sh`. It stubs core (8787) and web (3000) with one-line Node HTTP servers that echo their name, runs nginx from a temp prefix against a copy of the real config (rewritten only for the `proxy_params` include path), and asserts each path lands on the right upstream.

```bash
#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"   # cloudron/
tmp="$(mktemp -d)"
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$tmp"' EXIT

# Stub upstreams: core says CORE, web says WEB.
node -e 'require("http").createServer((_,r)=>r.end("CORE")).listen(8787)' & sleep 0.3
node -e 'require("http").createServer((_,r)=>r.end("WEB")).listen(3000)'  & sleep 0.3

# Copy config into temp prefix; point the proxy_params include at the temp copy
# AND redirect the runtime /run/* paths (pid, temp dirs) into $tmp so the test
# runs without root/writable-/run.
cp "$here/proxy_params" "$tmp/proxy_params"
sed -e "s#/app/pkg/proxy_params#$tmp/proxy_params#g" -e "s#/run/#$tmp/#g" \
    "$here/nginx.conf" > "$tmp/nginx.conf"
mkdir -p "$tmp/nginx-body" "$tmp/nginx-proxy"
nginx -p "$tmp" -c "$tmp/nginx.conf" & sleep 0.5

fail=0
check() { # path  expected
  got="$(curl -s "http://127.0.0.1:8000$1")"
  if [ "$got" != "$2" ]; then echo "FAIL $1 -> $got (want $2)"; fail=1
  else echo "ok   $1 -> $got"; fi
}

# Public → CORE
check /users/rss.xml CORE
check /users/alice/feed.xml CORE
check /users/alice/feed.json CORE
check /users/alice/following.opml CORE
check /post/abc123/comments.xml CORE
check /websub/callback/tok-xyz CORE
check /rsscloud/notify CORE
check /rsscloud/pleaseNotify CORE
check /hub CORE
# Everything else → WEB (incl. auth, stream, deeper/looser paths)
check / WEB
check /api/auth/sign-in/magic-link WEB
check /stream WEB
check /u/alice WEB
check /users/alice/feed.xml/extra WEB   # not single-segment → web
check /x/users/alice/feed.xml WEB       # not start-anchored → web
check /post/abc/comments.xml/more WEB

exit $fail
```

Make it executable: `chmod +x cloudron/test/routing-test.sh`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cloudron/test/routing-test.sh`
Expected: FAIL — `nginx.conf`/`proxy_params` do not exist yet (nginx can't start).

Requires nginx installed on the host: `sudo apt-get install -y nginx-light` if missing.

- [ ] **Step 3: Create `cloudron/proxy_params`**

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto https;
proxy_http_version 1.1;
```

- [ ] **Step 4: Create `cloudron/nginx.conf`**

Regex/prefix forms chosen to match the Caddy globs exactly: single-segment `*` (`[^/]+`), start-anchored, and `websub/callback/*` as a prefix. `location` longest-prefix/regex precedence keeps the public set ahead of the `/` catch-all.

```nginx
worker_processes 2;
error_log /dev/stderr warn;
pid /run/textcaster-nginx.pid;
events { worker_connections 1024; }

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    access_log /dev/stdout;
    client_body_temp_path /run/nginx-body;
    proxy_temp_path /run/nginx-proxy;
    client_max_body_size 12m;   # OPML/import headroom (core caps at 1m itself)
    sendfile on;

    server {
        listen 8000;
        server_name _;

        # Defense-in-depth: never expose dotfiles / VCS / common probes.
        location ~ /\.(?!well-known) { return 404; }

        # ── core PUBLIC surface (feeds + federation callbacks) → core:8787 ──
        location = /users/rss.xml { proxy_pass http://127.0.0.1:8787; include /app/pkg/proxy_params; }
        location ~ "^/users/[^/]+/feed\.xml$"      { proxy_pass http://127.0.0.1:8787; include /app/pkg/proxy_params; }
        location ~ "^/users/[^/]+/feed\.json$"     { proxy_pass http://127.0.0.1:8787; include /app/pkg/proxy_params; }
        location ~ "^/users/[^/]+/following\.opml$" { proxy_pass http://127.0.0.1:8787; include /app/pkg/proxy_params; }
        location ~ "^/post/[^/]+/comments\.xml$"   { proxy_pass http://127.0.0.1:8787; include /app/pkg/proxy_params; }
        location ^~ /websub/callback/ { proxy_pass http://127.0.0.1:8787; include /app/pkg/proxy_params; }
        location = /rsscloud/notify       { proxy_pass http://127.0.0.1:8787; include /app/pkg/proxy_params; }
        location = /rsscloud/pleaseNotify { proxy_pass http://127.0.0.1:8787; include /app/pkg/proxy_params; }
        location = /hub { proxy_pass http://127.0.0.1:8787; include /app/pkg/proxy_params; }

        # ── SSE: must not buffer or the live timeline stalls ──
        location = /stream {
            proxy_pass http://127.0.0.1:3000;
            include /app/pkg/proxy_params;
            proxy_set_header Connection "";
            proxy_buffering off;
            proxy_cache off;
            add_header X-Accel-Buffering no;
            proxy_read_timeout 24h;
        }

        # ── everything else → web:3000 (UI + /api/auth proxy + …) ──
        location / { proxy_pass http://127.0.0.1:3000; include /app/pkg/proxy_params; }
    }
}
```

> The regex `location`s are unanchored-precedence-safe because each is fully `^…$`-anchored; nginx tries them top-to-bottom and the first match wins, so ordering the exact/regex public blocks before `location /` is what routes them to core. `location = /hub` (exact) beats `location /`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cloudron/test/routing-test.sh`
Expected: every line `ok`, exit 0. In particular the two negative cases (`/users/alice/feed.xml/extra`, `/x/users/alice/feed.xml`) resolve to WEB — proving the split doesn't over-match (the security property).

- [ ] **Step 6: Commit**

```bash
git add cloudron/nginx.conf cloudron/proxy_params cloudron/test/routing-test.sh
git commit -m "cloudron: nginx Caddy-split (public→core, rest→web) + SSE + path-parity test

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: start.sh (secrets, env mapping, supervisor)

**Files:**
- Create: `cloudron/start.sh`
- Test: `cloudron/test/start-helpers.test.sh` (tests the pure, host-runnable pieces: secret idempotency + SMTP-URL construction)

**Interfaces:**
- Consumes: Cloudron env (`CLOUDRON_APP_ORIGIN`, `CLOUDRON_MAIL_SMTP_SERVER/PORT/USERNAME/PASSWORD`, `CLOUDRON_MAIL_FROM`), the files at `/app/pkg/{nginx.conf,proxy_params}` (Task 3), core at `/app/code/core/src/server.ts`, web at `/app/code/web/build/index.js`.
- Produces: exported `TEXTCASTER_*` + web env; three supervised processes; container exits on any death.

- [ ] **Step 1: Write the failing test**

Create `cloudron/test/start-helpers.test.sh`. It sources the two helper functions out of `start.sh` (defined near the top, guarded so sourcing doesn't launch servers) and checks them.

```bash
#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# Source only the helpers (start.sh returns early when TC_SOURCE_ONLY=1).
TC_SOURCE_ONLY=1 source "$here/start.sh"

# 1. Secret generation is idempotent: same value on repeat.
f="$tmp/secret"
a="$(tc_ensure_secret "$f")"
b="$(tc_ensure_secret "$f")"
[ "$a" = "$b" ] && [ -n "$a" ] && echo "ok  secret idempotent" || { echo "FAIL secret"; exit 1; }

# 2. SMTP URL is built and percent-encoded.
url="$(tc_smtp_url 'mail.example.com' '2525' 'user@x' 'p@ss:/word')"
[ "$url" = "smtp://user%40x:p%40ss%3A%2Fword@mail.example.com:2525" ] \
  && echo "ok  smtp url encoded" || { echo "FAIL smtp: $url"; exit 1; }
```

Make executable: `chmod +x cloudron/test/start-helpers.test.sh`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cloudron/test/start-helpers.test.sh`
Expected: FAIL — `start.sh` does not exist.

- [ ] **Step 3: Create `cloudron/start.sh`**

```bash
#!/bin/bash
set -eu

# ── Helper functions (also sourced by the test with TC_SOURCE_ONLY=1) ──
tc_ensure_secret() { # $1 = file; prints the secret, generating once.
  local f="$1"
  [ -f "$f" ] || { umask 077; openssl rand -hex 32 > "$f"; }
  cat "$f"
}

tc_urlenc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }

tc_smtp_url() { # server port user pass
  printf 'smtp://%s:%s@%s:%s' "$(tc_urlenc "$3")" "$(tc_urlenc "$4")" "$1" "$2"
}

[ "${TC_SOURCE_ONLY:-0}" = "1" ] && return 0

# ── Runtime ──
echo "==> Textcaster: preparing /app/data"
mkdir -p /app/data/config

# Secrets: generate once, persist, NEVER regenerate (would drop all sessions).
export TEXTCASTER_AUTH_SECRET="$(tc_ensure_secret /app/data/config/auth_secret)"
export TEXTCASTER_TOKEN="$(tc_ensure_secret /app/data/config/ops_token)"

# Map Cloudron env → Textcaster/core.
export TEXTCASTER_DB="/app/data/textcaster.db"
export TEXTCASTER_PUBLIC_URL="${CLOUDRON_APP_ORIGIN}"
export TEXTCASTER_WEB_ORIGIN="${CLOUDRON_APP_ORIGIN}"
export TEXTCASTER_WEBSUB="self"
export TEXTCASTER_RSSCLOUD="on"
export TEXTCASTER_PUSH_IN="on"
export TEXTCASTER_PORT="8787"
if [ -n "${CLOUDRON_MAIL_SMTP_SERVER:-}" ]; then
  export TEXTCASTER_SMTP_URL="$(tc_smtp_url "$CLOUDRON_MAIL_SMTP_SERVER" "$CLOUDRON_MAIL_SMTP_PORT" "$CLOUDRON_MAIL_SMTP_USERNAME" "$CLOUDRON_MAIL_SMTP_PASSWORD")"
  export TEXTCASTER_MAIL_FROM="${CLOUDRON_MAIL_FROM}"
fi

# web (adapter-node) env. XFF_DEPTH=2 for the Cloudron-proxy → nginx chain
# (verify in the install smoke; see Task 6).
export CORE_API_URL="http://127.0.0.1:8787"
export PORT="3000"
export ORIGIN="${CLOUDRON_APP_ORIGIN}"
export ADDRESS_HEADER="X-Forwarded-For"
export XFF_DEPTH="2"

chown -R cloudron:cloudron /app/data

# nginx first, so the health check answers during boot.
cp /app/pkg/nginx.conf /run/textcaster-nginx.conf
mkdir -p /run/nginx-body /run/nginx-proxy
echo "==> Starting nginx on :8000"
nginx -c /run/textcaster-nginx.conf

# core (migrations run automatically at boot) — write diagnostics under /tmp.
echo "==> Starting core on :8787"
cd /tmp
gosu cloudron:cloudron env NODE_OPTIONS="" node /app/code/core/src/server.ts &
CORE_PID=$!

# web immediately — it degrades gracefully if core is briefly unready.
echo "==> Starting web on :3000"
gosu cloudron:cloudron node /app/code/web/build/index.js &
WEB_PID=$!

# No hand-rolled watchdog: if any process dies, exit → Cloudron restarts us.
echo "==> Up (core=$CORE_PID web=$WEB_PID). Waiting…"
wait -n
echo "==> A process exited; stopping so Cloudron restarts the container."
exit 1
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cloudron/test/start-helpers.test.sh`
Expected: `ok  secret idempotent` and `ok  smtp url encoded`, exit 0.

- [ ] **Step 5: Shellcheck (catch quoting/portability bugs)**

Run: `shellcheck cloudron/start.sh` (install with `sudo apt-get install -y shellcheck` if missing)
Expected: no errors. (Warnings about `gosu`/`nginx` being unrecognized are fine.)

- [ ] **Step 6: Commit**

```bash
git add cloudron/start.sh cloudron/test/start-helpers.test.sh
git commit -m "cloudron: start.sh — generate-once secrets, env map, wait -n supervisor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Dockerfile + operator README + build verification

**Files:**
- Create: `cloudron/Dockerfile`
- Create: `cloudron/README.md`
- Test: build the image and assert its contents (no separate test file — the build + `docker run` checks are the test).

**Interfaces:**
- Consumes: everything above (`cloudron/{CloudronManifest.json,nginx.conf,proxy_params,start.sh,logo.png}`), the repo workspaces (`core/`, `web/`), root `package.json`/`package-lock.json`.
- Produces: a runnable Cloudron image whose `CMD` is `/app/pkg/start.sh`.

- [ ] **Step 1: Create `cloudron/Dockerfile`**

Build context is the repo root; the image installs Node 22.x, builds web, sets `NODE_ENV` after, symlinks `core/data → /app/data`, and stages the package files to `/app/pkg`.

```dockerfile
FROM cloudron/base:5.0.0@sha256:04fd70dbd8ad6149c19de39e35718e024417c3e01dc9c6637eaf4a41ec4e596c

# Node 22.x — core runs .ts via native type stripping (needs >=22.18).
ARG NODE_VERSION=22.22.0
RUN mkdir -p /usr/local/node-$NODE_VERSION && \
    curl -fsSL https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.gz \
      | tar zxf - --strip-components 1 -C /usr/local/node-$NODE_VERSION
ENV PATH="/usr/local/node-$NODE_VERSION/bin:$PATH"

RUN mkdir -p /app/code /app/pkg /app/data
WORKDIR /app/code

# Workspace install (no NODE_ENV yet — web build needs devDeps).
COPY package.json package-lock.json ./
COPY core/package.json core/package.json
COPY web/package.json web/package.json
RUN chown -R cloudron:cloudron /app/code && \
    gosu cloudron:cloudron npm ci

# App source, then build web (adapter-node → web/build).
COPY . /app/code
RUN chown -R cloudron:cloudron /app/code && \
    gosu cloudron:cloudron npm run build -w web

ENV NODE_ENV=production

# Writable data dir: symlink in the Dockerfile (read-only at runtime).
RUN rm -rf /app/code/core/data && ln -s /app/data /app/code/core/data

# Stage package files to read-only /app/pkg.
COPY cloudron/start.sh cloudron/nginx.conf cloudron/proxy_params /app/pkg/
RUN chmod +x /app/pkg/start.sh

CMD [ "/app/pkg/start.sh" ]
```

> Note: no `build-essential`/`python3`. If `npm ci` fails compiling better-sqlite3 (no prebuilt binary for the pinned Node ABI), it fails **here at build time** — add `RUN apt-get update && apt-get install -y build-essential python3 && rm -rf /var/lib/apt/lists/*` before `npm ci` **then**, and record it.

- [ ] **Step 2: Verify the current base image + Node pin**

Confirm the `cloudron/base` tag+digest and Node version are current (never fabricate):

```bash
# Base: check a live Cloudron package's Dockerfile at git.cloudron.io/packages/
# and confirm 5.0.0's digest, or `docker pull cloudron/base:5.0.0` and read `docker inspect`.
# Node: confirm 22.22.0 (or the latest 22.x >= 22.18) exists at nodejs.org/dist.
docker pull cloudron/base:5.0.0
```

Update the `FROM` digest / `NODE_VERSION` if either has moved, then proceed.

- [ ] **Step 3: Build the image**

Run (from repo root):

```bash
docker build -f cloudron/Dockerfile -t textcaster-cloudron:dev .
```

Expected: build completes; the `npm run build -w web` step produces `web/build`.

- [ ] **Step 4: Verify image contents (this is the test)**

```bash
# No secrets baked in:
docker run --rm textcaster-cloudron:dev sh -c 'find / -name ".env" 2>/dev/null | grep -v proc || echo NO_ENV_FILES'
# Expected: NO_ENV_FILES

# Build artifacts + entrypoints present:
docker run --rm textcaster-cloudron:dev sh -c 'ls /app/code/web/build/index.js /app/code/core/src/server.ts /app/pkg/start.sh /app/pkg/nginx.conf /app/pkg/proxy_params'
# Expected: all five paths listed, no errors

# core/data is a symlink to /app/data:
docker run --rm textcaster-cloudron:dev sh -c 'readlink /app/code/core/data'
# Expected: /app/data

# Node present and correct major:
docker run --rm textcaster-cloudron:dev node -v
# Expected: v22.x (>= 22.18)
```

- [ ] **Step 5: Write `cloudron/README.md`**

Operator doc — build, install, env, backup note. Content:

```markdown
# Textcaster on Cloudron

Packages Textcaster (core + web + nginx) as a single Cloudron app. SQLite on
the `localstorage` addon; email via the `sendmail` addon. See the design at
`docs/superpowers/specs/2026-07-18-textcaster-cloudron-design.md`.

## Build & install

    # from the repo root
    cloudron build --set-build-service <your-build-service>   # or: docker build -f cloudron/Dockerfile -t <registry>/textcaster:dev .
    cloudron install --image <registry>/textcaster:dev

`cloudron build` reads `cloudron/CloudronManifest.json`; run it from the repo
root so the whole workspace is the build context, pointing at `cloudron/Dockerfile`.

## What it wires automatically

- `CLOUDRON_APP_ORIGIN` → `TEXTCASTER_PUBLIC_URL` / `TEXTCASTER_WEB_ORIGIN` / web `ORIGIN`
- SQLite at `/app/data/textcaster.db` (WAL mode)
- `TEXTCASTER_AUTH_SECRET` + `TEXTCASTER_TOKEN` generated once into `/app/data/config/` (stable across restarts)
- `sendmail` addon → `TEXTCASTER_SMTP_URL` (verify / magic-link / reset emails deliver for real)
- Federation on: WebSub (`self` hub at `/hub`) + rssCloud + push-in

## Data & backups

All state lives in `/app/data` (the SQLite DB + its `-wal`/`-shm`, and the
generated secrets), which Cloudron backs up. The DB runs in WAL mode; the
`-wal`/`-shm` files are backed up alongside `textcaster.db`, so a restore
replays cleanly. For a manual belt-and-suspenders checkpoint before an ad-hoc
backup: `cloudron exec -- sh -c 'sqlite3 /app/data/textcaster.db "PRAGMA wal_checkpoint(TRUNCATE);"'`.
```

- [ ] **Step 6: Commit**

```bash
git add cloudron/Dockerfile cloudron/README.md
git commit -m "cloudron: Dockerfile (Node 22, build web, symlink data) + operator README

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Install smoke on Cloudron (human gate)

Automated tests cover WAL, manifest, routing, and start.sh helpers; full end-to-end needs a real Cloudron box and is operator-run. This task is a checklist, not code.

**Files:** none (verification only).

- [ ] **Step 1: Install**

```bash
cloudron install --image <registry>/textcaster:dev --location textcaster.<your-domain>
cloudron logs -f --app textcaster.<your-domain>   # watch "Starting nginx / core / web / Up"
```

- [ ] **Step 2: Smoke the 7 success criteria (from the spec)**

1. Home timeline renders (view source with JS off — server-rendered).
2. Compose a post → renders rich (Carta/unified).
3. Reply → threads inline + on the conversation page.
4. Add a remote feed → polls in within one interval.
5. Register an email account → verification email **arrives** (real delivery via sendmail) and the link works; magic-link sign-in works.
6. A WebSub/rssCloud round-trip delivers a post live (e.g. subscribe another instance to `/users/rss.xml`).
7. `cloudron restart` → DB intact **and still logged in** (secrets stable).

- [ ] **Step 3: Verify client IP resolution (XFF_DEPTH)**

Confirm rate-limiting sees the real client, not the proxy. From two different public IPs, hit an anon-mint path; check `cloudron logs` show distinct client addresses (not `127.0.0.1` or the Cloudron proxy IP). If wrong, adjust `XFF_DEPTH` in `cloudron/start.sh` (try 1 or 3), rebuild, redeploy, re-check; commit the corrected value.

- [ ] **Step 4: Verify feeds/federation are publicly reachable, internals are not**

```bash
curl -sI https://textcaster.<domain>/users/rss.xml        # 200 (public, core)
curl -sI https://textcaster.<domain>/hub                  # 200/405 (core hub)
curl -s   https://textcaster.<domain>/timeline            # NOT the core JSON API — should hit web (UI/404), never expose core's /timeline
```

- [ ] **Step 5: Record the result**

Note the outcome (and any `XFF_DEPTH`/base-image/Node adjustments made) in the commit message or a short line in `cloudron/README.md`. This closes the milestone.

---

## Notes for the executor

- **Order matters only loosely:** Task 1 (core WAL) is independent; Tasks 2–5 build the `cloudron/` package; Task 5 depends on 2–4 existing; Task 6 needs a real Cloudron box (human).
- **Host tooling the tests need:** `nginx` (Task 3), `shellcheck` (Task 4), `rsvg-convert` or ImageMagick (Task 2), Docker (Task 5). Each task's step notes the install command.
- **Do not** add the mongodb addon or a Mongo adapter — SQLite is what ships (see spec §"Data store"; Mongo is a design-preserved *future* path only).
```
