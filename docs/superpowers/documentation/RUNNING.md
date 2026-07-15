# Running Textcaster

Textcaster is two deployables: **core** (headless API) and **web**
(SvelteKit client). The web app talks to core only over plain HTTP, from its
own server-side code — core is never exposed to browsers, and there is no
CORS to configure. Browsers only ever talk to the web app.

## Prerequisites

- Node.js 22+ for the dev scripts (`core`'s dev script loads `.env` via
  Node's `--env-file-if-exists`); the built server code itself runs on 20+
- npm (workspaces are used; run all commands from the repo root)

## Install

```bash
npm install
```

## Configure

Copy the example env files and fill in a shared token:

```bash
cp core/.env.example core/.env
cp web/.env.example web/.env
```

`core/.env`:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `TEXTCASTER_TOKEN` | yes | — | Bearer token core requires on writes. |
| `TEXTCASTER_DB` | no | `./data/textcaster.db` | SQLite file path, or `:memory:`. |
| `TEXTCASTER_PORT` | no | `8787` | HTTP port core listens on. |
| `TEXTCASTER_POLL_SECONDS` | no | `60` | How often remote feeds are polled. |

`web/.env`:

| Variable | Required | Notes |
|---|---|---|
| `CORE_API_URL` | yes | Base URL of core, e.g. `http://localhost:8787`. |
| `CORE_API_TOKEN` | yes | **Must equal core's `TEXTCASTER_TOKEN`.** |

There is no `PUBLIC_CORE_SSE_URL` and nothing core-related is marked
`PUBLIC_*` — the browser never holds the token or a core URL. Live updates
reach the browser through web's own `/stream` route, which proxies core's
SSE endpoint server-side.

## Stale DB warning

**Schema changes are now migration-gated.** Core refuses to start against a
database it cannot handle, with a clear error instead of silent 500s:

- `pre-migration database — delete it (dev data only) and restart` — the file
  predates the migration system. **The first boot after this change will say
  exactly that for every existing dev DB, including freshly recreated
  spine-era ones.** Delete it:

  ```bash
  rm -f core/data/textcaster.db
  ```

- `database is newer than this build` — the file was created by a newer
  checkout; update your checkout (or delete the dev DB).

From now on, schema upgrades apply automatically at startup.

## Run

In two terminals, from the repo root:

```bash
npm run dev -w core
```

```bash
npm run dev -w web
```

Then open <http://localhost:5173>.

## Feature notes

- Posts carry an optional title: remote feed items keep the title from
  their feed; posts composed locally are untitled.
- Handles are lowercased and restricted to `[a-z0-9-]{1,64}`.
- Remote feeds accept RSS 2.0, Atom, or JSON Feed — whichever the URL
  serves.
- A newly added remote user's first poll backfills its existing feed items
  silently (no flood into the live timeline). From the second poll onward,
  new items appear live, the same as local posts.
- Feeds are polled every `TEXTCASTER_POLL_SECONDS` (default 60). A feed
  added just now shows its content within one poll interval.

## Deployment note

The `/stream` route proxies core's SSE endpoint and needs a streaming-capable
host. `adapter-auto`'s static/serverless targets are fine for local dev but
don't hold a long-lived response open in production. If you deploy the web
app for real (Docker/self-host/etc.), switch to `@sveltejs/adapter-node`
first — dev mode (`npm run dev -w web`) streams fine as-is regardless of
adapter.

## Manual verification

### Two-tab live test

1. Open `http://localhost:5173` in two browser tabs.
2. In tab A, submit the compose form (handle + content).
3. Tab B's timeline updates with the new post immediately, with no reload —
   proof that the SSE proxy delivers live posts across sessions.

### JS-disabled test

1. Disable JavaScript in the browser (or use `curl`/a text browser).
2. Load `http://localhost:5173`.
3. The timeline, composer, and "add remote user" form all render and work:
   the compose and add-remote forms are plain HTML `<form>` posts handled by
   SvelteKit form actions, and the timeline itself is server-rendered. Only
   the live (no-reload) update is JS-only; everything else works without it.

## curl cheat sheet

Health check:

```bash
curl http://localhost:8787/health
```

Read the timeline (no auth required):

```bash
curl http://localhost:8787/timeline
```

Create a local post (auth required — both `POST /users` and `POST /posts`
require `Authorization: Bearer <token>`, using core's `TEXTCASTER_TOKEN`):

```bash
curl -X POST http://localhost:8787/posts \
  -H "Authorization: Bearer $TEXTCASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"handle":"alice","displayName":"Alice","content":"hello, textcaster"}'
```

Add a remote user (also requires the bearer token):

```bash
curl -X POST http://localhost:8787/users \
  -H "Authorization: Bearer $TEXTCASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"handle":"bob-remote","displayName":"Bob","feedUrl":"https://example.com/feed.xml"}'
```
