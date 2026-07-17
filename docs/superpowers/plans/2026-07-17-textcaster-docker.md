# Textcaster Docker Compose Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a dev Compose stack (`docker compose up`, full live-reload) and a prod Compose stack (Caddy HTTPS, built images, Mailpit protected, WebSub/rssCloud federation reachable) in this monorepo, plus a rewritten README.

**Architecture:** SvelteKit gains `@sveltejs/adapter-node` so `web` runs as a Node server in a container. Dev runs core+web+Mailpit off the base `node:22-bookworm-slim` image with the repo bind-mounted and a named `node_modules` volume (container-built `better-sqlite3` wins). Prod builds core/web images; Caddy terminates HTTPS and routes core's PUBLIC paths (feeds + federation callbacks) to `core:8787` while everything else — including `/api/auth/*` — goes to `web:3000`.

**Tech Stack:** Docker Compose, `node:22-bookworm-slim`, Caddy 2, Mailpit, `@sveltejs/adapter-node@5.5.7`, SQLite (better-sqlite3 glibc prebuild).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-17-textcaster-docker-design.md` (rev 2). It wins on ambiguity.
- **F-1: `/api/auth/*` routes to WEB, never core** — emailed verify/magic/reset links are native GETs with no `Origin`; better-auth 403s cookie-bearing requests without one, and the web `/api/auth` proxy injects it + relays Set-Cookie/302. `@core` must NOT list `/api/auth/*`.
- **F-2: Caddy is on BOTH `frontend` and `backend`** networks so it reaches `core:8787`; **core publishes NO host ports** (that is the isolation, not the network membership).
- **F-3: prod web env sets `ADDRESS_HEADER=X-Forwarded-For` + `XFF_DEPTH=1`** (plus `ORIGIN`) so `getClientAddress()` resolves the real client behind Caddy for the rate limiter.
- `@core` allowlist (anchored regexes), verbatim: `/users/rss.xml`, `^/users/[^/]+/feed\.(xml|json)$`, `^/users/[^/]+/following\.opml$`, `^/post/[^/]+/comments\.xml$`, `/websub/callback/*`, `/rsscloud/notify`, `/rsscloud/pleaseNotify`, `/hub`. Everything else → web. `/peers` is INTERNAL.
- Dev: push OFF (no `TEXTCASTER_PUBLIC_URL`; WEBSUB/RSSCLOUD unset). Prod: push ON (`PUBLIC_URL`, `WEBSUB=self`, `RSSCLOUD=on`, `PUSH_IN=on`).
- Base image `node:22-bookworm-slim` (glibc → better-sqlite3 prebuild, no compile). Mailpit protected at `/mail` in prod (basic-auth), unprotected localhost in dev.
- New dep (user-approved): `@sveltejs/adapter-node`. No application logic changes beyond the adapter swap + two `start` scripts.
- Existing `npm test -w core` and `npm test -w web` must stay green.
- Shared checkout with a parallel session: stage EXPLICIT paths only (never `git add -A`). Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: adapter-node swap + prod start scripts

**Files:**
- Modify: `web/package.json` (dep + `start` script), `web/vite.config.ts` (adapter)
- Modify: `core/package.json` (`start` script)

**Interfaces:**
- Produces: `npm run build -w web` emits `web/build/index.js` (a Node server honoring `PORT`, `ORIGIN`, `ADDRESS_HEADER`, `XFF_DEPTH`); `npm run start -w web` = `node build/index.js`; `npm run start -w core` = `node src/server.ts` (no `--watch`, env from process env).

- [ ] **Step 1: Install adapter-node**

```bash
cd /home/rmdes/textcaster
npm install -w web --save-dev --save-exact @sveltejs/adapter-node@5.5.7
```

- [ ] **Step 2: Swap the adapter in `web/vite.config.ts`**

Change the import line and keep everything else identical:

```ts
import adapter from '@sveltejs/adapter-node';
```

(The `adapter: adapter()` call is unchanged — adapter-node takes no required options; `PORT`/`ORIGIN`/`ADDRESS_HEADER`/`XFF_DEPTH` are read at runtime from env.)

Optionally remove `@sveltejs/adapter-auto` from `web/package.json` devDependencies (it's now unused). If unsure, leave it — an unused devDep is harmless.

- [ ] **Step 3: Add `start` scripts**

`web/package.json` scripts — add `"start": "node build/index.js"`.
`core/package.json` scripts — add `"start": "node src/server.ts"` (Node 22.18+ native type-stripping runs the `.ts` entry directly, same as the `dev` script minus `--watch`/`--env-file`).

- [ ] **Step 4: Verify the build + suites**

```bash
npm run build -w web
test -f web/build/index.js && echo "adapter-node build OK"
npm test -w core 2>&1 | tail -3
npm test -w web 2>&1 | tail -3
cd web && npm run check 2>&1 | tail -1 && cd ..
```
Expected: `web/build/index.js` exists; core and web suites pass; svelte-check 0 errors. (The adapter change only affects `build`; `vite dev` and tests are unaffected.)

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/vite.config.ts core/package.json package-lock.json
git commit -m "web: adapter-node for containerized deploy; core+web start scripts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Prod Dockerfiles + .dockerignore

**Files:**
- Create: `docker/Dockerfile.core`, `docker/Dockerfile.web`, `.dockerignore`

**Interfaces:**
- Consumes: Task 1's `start` scripts and `web/build`.
- Produces: `core` image (runs `node src/server.ts`, listens :8787) and `web` image (runs `node build/index.js`, listens :3000), referenced by `compose.prod.yaml` (Task 4).

- [ ] **Step 1: `.dockerignore`** (keep build context lean; never copy host node_modules or local DBs into images):

```
node_modules
**/node_modules
**/data
*.db
.git
.svelte-kit
web/build
.env
.superpowers
docs
```

- [ ] **Step 2: `docker/Dockerfile.core`**

```dockerfile
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Whole repo (workspaces hoist to root node_modules); .dockerignore prunes it.
COPY . .
RUN npm ci
EXPOSE 8787
# Prod start: no --watch, env comes from the container (compose), not a file.
CMD ["npm", "run", "start", "-w", "core"]
```

- [ ] **Step 3: `docker/Dockerfile.web`** (multi-stage: build with adapter-node, then a runtime that carries `build/` + node_modules)

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build -w web

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# adapter-node's build/ imports non-bundled deps from node_modules at runtime.
# Copying the built node_modules is the reliable path (size-prune is a later
# optimization, not correctness-critical for v1 self-host).
COPY --from=build /app/web/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/web/package.json ./package.json
EXPOSE 3000
CMD ["node", "build/index.js"]
```

- [ ] **Step 4: Verify both images build**

```bash
docker build -f docker/Dockerfile.core -t textcaster-core:test .
docker build -f docker/Dockerfile.web -t textcaster-web:test .
```
Expected: both build successfully. Quick smoke that web's entry is present:
```bash
docker run --rm textcaster-web:test node -e "require('fs').accessSync('build/index.js'); console.log('web entry OK')"
```
(If `docker` is unavailable in the execution environment, report BLOCKED with that fact — the Dockerfiles are still committable and the human runs the build; do not fake the output.)

- [ ] **Step 5: Commit**

```bash
git add docker/Dockerfile.core docker/Dockerfile.web .dockerignore
git commit -m "docker: prod images for core and web

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Dev `compose.yaml` (full stack, live reload)

**Files:**
- Create: `compose.yaml`

**Interfaces:**
- Consumes: base `node:22-bookworm-slim`, the repo source, Task 1's `dev` scripts.
- Produces: `docker compose up` → core :8787, web :5173, Mailpit :8025.

- [ ] **Step 1: Write `compose.yaml`**

```yaml
# Textcaster — DEV stack. `docker compose up` and edit on the host; core
# (node --watch) and web (vite) hot-reload in the containers. Push federation
# is OFF here (no PUBLIC_URL). Mailpit UI is unprotected — localhost only.
services:
  mailpit:
    image: axllent/mailpit:latest
    container_name: textcaster-mailpit
    ports:
      - "8025:8025" # web UI (read verify/magic-link emails here)
      - "1025:1025" # SMTP (also reachable in-network as mailpit:1025)
    restart: unless-stopped

  core:
    image: node:22-bookworm-slim
    container_name: textcaster-core
    working_dir: /app
    # One npm ci populates the shared root node_modules volume (workspaces
    # hoist), then core runs in watch mode. web waits for core to be healthy.
    command: sh -c "npm ci && npm run dev -w core"
    environment:
      TEXTCASTER_AUTH_SECRET: dev-secret-not-for-production-000000000000
      TEXTCASTER_TOKEN: dev-token
      TEXTCASTER_SMTP_URL: smtp://mailpit:1025
      TEXTCASTER_MAIL_FROM: textcaster@localhost
      TEXTCASTER_DB: /app/core/data/dev.db
      TEXTCASTER_WEB_ORIGIN: http://localhost:5173
    volumes:
      - ./:/app
      - node_modules:/app/node_modules # container's linux better-sqlite3 wins
    ports:
      - "8787:8787"
    depends_on:
      - mailpit
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:8787/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 30
      start_period: 60s # first boot runs npm ci
    restart: unless-stopped

  web:
    image: node:22-bookworm-slim
    container_name: textcaster-web
    working_dir: /app
    # node_modules is already populated by core's npm ci (shared volume); just
    # run vite. --host exposes the dev server outside the container.
    command: sh -c "npm run dev -w web -- --host 0.0.0.0"
    environment:
      CORE_API_URL: http://core:8787
    volumes:
      - ./:/app
      - node_modules:/app/node_modules
    ports:
      - "5173:5173"
    depends_on:
      core:
        condition: service_healthy
    restart: unless-stopped

volumes:
  node_modules:
```

- [ ] **Step 2: Smoke the dev stack**

```bash
docker compose up -d --wait   # waits for healthchecks
curl -s -o /dev/null -w "core /health: %{http_code}\n" http://localhost:8787/health
curl -s -o /dev/null -w "web root: %{http_code}\n" http://localhost:5173/
curl -s -o /dev/null -w "mailpit: %{http_code}\n" http://localhost:8025/
curl -s http://localhost:5173/ | grep -q "Textcaster" && echo "web renders (web->core proxy path alive)"
```
Expected: core 200, web 200, mailpit 200, "web renders". Confirm the bind-mount/volume pattern by editing a source file and seeing the reload in `docker compose logs`. Then `docker compose down`.

Plan-time smoke checks (spec/review): confirm `better-sqlite3` resolved from the ROOT `node_modules` volume (`docker compose exec core node -e "require('better-sqlite3'); console.log('sqlite ok')"`); if a nested `core/node_modules` carried the native build, add a second volume for it and note it in the report. (`docker` unavailable → report BLOCKED, commit the file, human smokes it.)

- [ ] **Step 3: Commit**

```bash
git add compose.yaml
git commit -m "docker: dev compose — core+web+mailpit, live reload, one command

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Prod `compose.prod.yaml` + `Caddyfile` + `.env.example` + secrets script

**Files:**
- Create: `compose.prod.yaml`, `Caddyfile`, `.env.example`, `scripts/generate-env.sh`

**Interfaces:**
- Consumes: Task 2's images; F-1/F-2/F-3 routing rules.
- Produces: `docker compose -f compose.prod.yaml up -d` → Caddy(:80/:443) → web/core/mailpit.

- [ ] **Step 1: `Caddyfile`** (the public/internal split — F-1/F-2 baked in)

```
{$TEXTCASTER_DOMAIN} {
	# Mailpit UI — MUST be protected: it shows verify/magic-link emails, so
	# anyone who could read /mail could sign in as any user.
	handle /mail* {
		basic_auth {
			{$MAILPIT_USER} {$MAILPIT_PASSWORD_HASH}
		}
		reverse_proxy mailpit:8025
	}

	# core PUBLIC surface: feeds + federation push-callbacks ONLY.
	# NOT /api/auth/* — emailed link-clicks are native GETs with no Origin, and
	# better-auth 403s cookie-bearing requests without one. They go through the
	# web app's /api/auth proxy (injects Origin, relays Set-Cookie + 302) via
	# the catch-all below — the same path dev takes.
	@core {
		path /users/rss.xml
		path_regexp ^/users/[^/]+/feed\.(xml|json)$
		path_regexp ^/users/[^/]+/following\.opml$
		path_regexp ^/post/[^/]+/comments\.xml$
		path /websub/callback/*
		path /rsscloud/notify /rsscloud/pleaseNotify
		path /hub
	}
	handle @core {
		reverse_proxy core:8787
	}

	# everything else → the SvelteKit app (UI + /api/auth proxy + /stream etc.)
	handle {
		reverse_proxy web:3000
	}
}
```

- [ ] **Step 2: `compose.prod.yaml`**

```yaml
# Textcaster — PROD stack for VPS self-host. Caddy terminates HTTPS and fronts
# everything; core publishes NO host ports (backend-only isolation). Federation
# (WebSub/rssCloud) is ON. Run: docker compose -f compose.prod.yaml up -d --build
services:
  caddy:
    image: caddy:2-alpine
    container_name: textcaster-caddy
    depends_on:
      web:
        condition: service_started
      core:
        condition: service_healthy
    environment:
      TEXTCASTER_DOMAIN: ${TEXTCASTER_DOMAIN:?Set TEXTCASTER_DOMAIN in .env}
      MAILPIT_USER: ${MAILPIT_USER:-mail}
      MAILPIT_PASSWORD_HASH: ${MAILPIT_PASSWORD_HASH:?Set MAILPIT_PASSWORD_HASH (run scripts/generate-env.sh)}
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    restart: unless-stopped
    networks: [frontend, backend] # F-2: needs backend to reach core:8787

  web:
    build:
      context: .
      dockerfile: docker/Dockerfile.web
    container_name: textcaster-web
    environment:
      CORE_API_URL: http://core:8787
      PORT: "3000"
      ORIGIN: https://${TEXTCASTER_DOMAIN:?Set TEXTCASTER_DOMAIN in .env}
      ADDRESS_HEADER: X-Forwarded-For # F-3: getClientAddress() behind Caddy
      XFF_DEPTH: "1"
    depends_on:
      core:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 512M
    restart: unless-stopped
    networks: [frontend, backend]

  core:
    build:
      context: .
      dockerfile: docker/Dockerfile.core
    container_name: textcaster-core
    environment:
      TEXTCASTER_AUTH_SECRET: ${TEXTCASTER_AUTH_SECRET:?Set TEXTCASTER_AUTH_SECRET (run scripts/generate-env.sh)}
      TEXTCASTER_TOKEN: ${TEXTCASTER_TOKEN:?Set TEXTCASTER_TOKEN (run scripts/generate-env.sh)}
      TEXTCASTER_DB: /data/textcaster.db
      TEXTCASTER_PUBLIC_URL: https://${TEXTCASTER_DOMAIN:?Set TEXTCASTER_DOMAIN in .env}
      TEXTCASTER_WEB_ORIGIN: https://${TEXTCASTER_DOMAIN}
      TEXTCASTER_WEBSUB: ${TEXTCASTER_WEBSUB:-self}
      TEXTCASTER_RSSCLOUD: ${TEXTCASTER_RSSCLOUD:-on}
      TEXTCASTER_PUSH_IN: ${TEXTCASTER_PUSH_IN:-on}
      TEXTCASTER_SMTP_URL: ${TEXTCASTER_SMTP_URL:-smtp://mailpit:1025}
      TEXTCASTER_MAIL_FROM: ${TEXTCASTER_MAIL_FROM:-textcaster@${TEXTCASTER_DOMAIN}}
    volumes:
      - core-data:/data
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:8787/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 10
      start_period: 20s
    deploy:
      resources:
        limits:
          memory: 512M
    restart: unless-stopped
    networks: [backend] # NO published ports — reachable only via Caddy/web

  mailpit:
    image: axllent/mailpit:latest
    container_name: textcaster-mailpit
    environment:
      MP_WEBROOT: /mail
    restart: unless-stopped
    networks: [frontend, backend]

volumes:
  core-data:
  caddy-data:
  caddy-config:

networks:
  frontend:
  backend:
```

- [ ] **Step 3: `.env.example`**

```bash
# Textcaster — self-host configuration. Copy to .env and edit, or run:
#   ./scripts/generate-env.sh
# (fills the domain, generates secrets, and the Mailpit bcrypt hash).

# ─── Required ────────────────────────────────────────────────────────────────
# Your domain (DNS A/AAAA must point at this server; Caddy issues HTTPS for it).
TEXTCASTER_DOMAIN=textcaster.example.com

# Secrets — generate-env.sh fills these with `openssl rand -hex 32`.
TEXTCASTER_AUTH_SECRET=
TEXTCASTER_TOKEN=

# Mailpit UI (/mail) basic-auth. Mailpit shows every outgoing email, including
# sign-in links, so it MUST be protected. MAILPIT_PASSWORD_HASH is a bcrypt
# hash (Caddy verifies the hash). generate-env.sh fills the hash for you.
MAILPIT_USER=mail
MAILPIT_PASSWORD_HASH=

# ─── SMTP delivery ───────────────────────────────────────────────────────────
# Default: mail is caught by the bundled Mailpit (view at /mail) but NOT
# delivered to real inboxes. For a real multi-user instance, point this at a
# real SMTP server so verification/magic-link/reset emails actually arrive:
#   TEXTCASTER_SMTP_URL=smtps://user:pass@smtp.example.com:465
#   TEXTCASTER_MAIL_FROM=noreply@example.com
# TEXTCASTER_SMTP_URL=smtp://mailpit:1025
# TEXTCASTER_MAIL_FROM=textcaster@your-domain

# ─── Federation (defaults on for prod) ───────────────────────────────────────
# TEXTCASTER_WEBSUB=self   # self-hosted WebSub hub at /hub; or an external hub URL
# TEXTCASTER_RSSCLOUD=on
# TEXTCASTER_PUSH_IN=on
```

- [ ] **Step 4: `scripts/generate-env.sh`** (executable)

```bash
#!/usr/bin/env bash
# Generate .env for Textcaster. Prod (default) fills domain + strong secrets +
# the Mailpit bcrypt hash; --dev writes a localhost dev .env (weak, push off).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--dev" ]; then
	cat > .env <<EOF
# Dev .env (generated). Not for production.
TEXTCASTER_DOMAIN=localhost
TEXTCASTER_AUTH_SECRET=$(openssl rand -hex 32)
TEXTCASTER_TOKEN=dev-token
MAILPIT_USER=mail
MAILPIT_PASSWORD_HASH=
EOF
	echo "Wrote dev .env (use with: docker compose up)."
	exit 0
fi

read -rp "Domain (e.g. textcaster.example.com): " DOMAIN
read -rsp "Mailpit /mail password: " MP_PW; echo
HASH="$(docker run --rm caddy:2-alpine caddy hash-password --plaintext "$MP_PW")"
cat > .env <<EOF
TEXTCASTER_DOMAIN=$DOMAIN
TEXTCASTER_AUTH_SECRET=$(openssl rand -hex 32)
TEXTCASTER_TOKEN=$(openssl rand -hex 32)
MAILPIT_USER=mail
MAILPIT_PASSWORD_HASH=$HASH
EOF
echo "Wrote .env. Review it, then: docker compose -f compose.prod.yaml up -d --build"
```

Make it executable: `chmod +x scripts/generate-env.sh`.

- [ ] **Step 5: Validate (config parses; full run is the human gate)**

```bash
docker compose -f compose.prod.yaml config >/dev/null && echo "prod compose parses"
bash -n scripts/generate-env.sh && echo "generate-env.sh syntax OK"
```
Expected: both OK. (Note: `docker compose config` needs the required env vars to interpolate — run it with a throwaway `.env` from `./scripts/generate-env.sh --dev` plus a `TEXTCASTER_DOMAIN`, or export the `${VAR:?}` vars inline; if `docker` is unavailable, report BLOCKED and rely on the human prod smoke.) The full prod smoke (HTTPS up, `/mail` basic-auth prompt, `https://domain/users/rss.xml` returns RSS from core, a WebSub subscribe reaches core) is Task 6's human gate.

- [ ] **Step 6: Commit**

```bash
git add compose.prod.yaml Caddyfile .env.example scripts/generate-env.sh
git commit -m "docker: prod compose — Caddy HTTPS, protected Mailpit, federation, secrets script

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: README rewrite

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Rewrite `README.md`** with these sections (real content, no placeholders):
  - **What Textcaster is** — a feeds-native social timeline where people who post here and people who post on their own site are equal citizens; posts, replies, and whole conversations travel as RSS, so following/threading/federation work over open feeds. Built on Textcasting; inspired by Dave Winer's rss.chat.
  - **Develop** — `git clone` → `cp .env.example .env` (or `./scripts/generate-env.sh --dev`) → `docker compose up` → app at http://localhost:5173, Mailpit inbox at http://localhost:8025. Edits hot-reload; no host Node needed.
  - **Self-host on a VPS** — point DNS at the server → `./scripts/generate-env.sh` (domain, secrets, Mailpit hash) → `docker compose -f compose.prod.yaml up -d --build`. Caddy issues HTTPS automatically. Mailpit UI is at `/mail` (basic-auth). Federation (WebSub + rssCloud) is on by default. **Real email delivery needs real SMTP** — point `TEXTCASTER_SMTP_URL` at your SMTP server (Mailpit only catches, never delivers).
  - **Architecture** — one paragraph: `core` (Hono/Node + SQLite + better-auth, serves feeds + federation), `web` (SvelteKit, the UI + auth proxy), Caddy front door; the public/internal routing split in one sentence.
  - **Docs** — link `docs/superpowers/specs/` and `docs/superpowers/documentation/RUNNING.md`.

- [ ] **Step 2: Sanity check** — no broken relative links, no `TODO`/placeholder text:
```bash
grep -nE "TODO|TBD|FIXME|placeholder|example\.com" README.md || echo "clean"
```
(`example.com` only acceptable inside the self-host example command — confirm each hit is intentional.)

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README — what Textcaster is, dev + self-host quick-starts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Human smoke gate (dev + prod)

**Files:** none (verification; controller records the outcome, no subagent).

- [ ] **Dev:** `docker compose up` → register a user → the verification email appears in Mailpit (:8025) → clicking its link logs in. Edit a source file → confirm hot reload.
- [ ] **Prod (against a real/staging domain):** `docker compose -f compose.prod.yaml up -d --build` comes healthy → the app loads over HTTPS → `/mail` prompts basic-auth → `https://<domain>/users/rss.xml` returns RSS (core route works) → a WebSub subscribe to `https://<domain>/users/<handle>/feed.xml` reaches core (federation path) → an emailed verify link (a `/api/auth/*` GET) resolves through the web proxy and logs in (F-1 works end to end).

---

## Plan self-review notes (done at write time)

- Spec coverage: adapter-node swap + start scripts (T1), Dockerfiles + dockerignore (T2), dev compose w/ live-reload + named-node_modules volume (T3), prod compose + Caddyfile w/ F-1/F-2/F-3 + .env.example + secrets script (T4), README (T5), human smoke incl. the F-1 emailed-link path (T6). Base image/native-module and Mailpit-protection reasoning carried into the relevant files.
- F-1/F-2/F-3 are encoded as literal file content (Caddy `@core` omits `/api/auth/*`; caddy on `[frontend, backend]`, core on `[backend]` with no ports; web env has `ADDRESS_HEADER`/`XFF_DEPTH`) AND restated in Global Constraints so a reviewer checks them directly.
- Infra reality: several steps depend on `docker` being present in the execution environment. Each such step says: if docker is unavailable, commit the file and report BLOCKED for that verification — never fabricate build/run output; the human smoke (T6) is the real gate.
- Type/name consistency: `TEXTCASTER_*` env names match `core/src/config.ts`; `CORE_API_URL` matches web; the `@core` allowlist matches the spec verbatim (anchored); `node_modules` volume name consistent across T3.
- YAGNI: web image copies full node_modules (correct, size-prune deferred); no init-once guard on dev `npm ci` (noted as optional); no push exposure in dev.
