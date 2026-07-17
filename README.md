# Textcaster

A feeds-native social timeline. People who post through the instance and
people who post on their own site are equal citizens in the same timeline —
posts, replies, and whole conversations travel as RSS, so following,
threading, and federation all work over open feeds instead of a proprietary
API.

Textcaster is built on [Textcasting](https://textcasting.org) and inspired by
Dave Winer's [rss.chat](https://github.com/scripting/rss.chat). It takes RSS
/ OPML / JSON Feed / WebSub from that tradition and Micropub / Webmention /
IndieAuth / microformats2 from the IndieWeb, and unites them in one place.

> **Status: the spine is runnable end to end.** Local posts and remote feed
> items live in one timeline, server-rendered and updating live over SSE. The
> founding design is in
> [`docs/superpowers/specs/2026-07-15-textcaster-design.md`](docs/superpowers/specs/2026-07-15-textcaster-design.md).

## Develop

Docker Compose runs the whole dev stack — no host Node install needed.

```bash
git clone <this repo> && cd textcaster
cp .env.example .env          # or: ./scripts/generate-env.sh --dev
docker compose up
```

- App: [http://localhost:5173](http://localhost:5173)
- Mailpit (catches every outgoing email — verify links, magic links):
  [http://localhost:8025](http://localhost:8025)

Edits to `core` and `web` hot-reload in the containers (`node --watch` and
`vite dev`). Federation push is off in dev.

## Self-host on a VPS

```bash
# 1. Point DNS (A/AAAA) at the server for your domain first.
./scripts/generate-env.sh              # prompts for domain + Mailpit password,
                                        # generates secrets and writes .env
docker compose -f compose.prod.yaml up -d --build
```

Caddy fronts everything and issues HTTPS automatically for
`TEXTCASTER_DOMAIN` — no manual certificates. The Mailpit UI is reachable at
`/mail` behind HTTP basic-auth (the credentials `generate-env.sh` just
generated), since it displays every verify/magic-link email that goes out.
Federation (WebSub + rssCloud) is **on by default** in this stack.

**Mailpit only catches mail — it never delivers it.** That's fine for
trying the instance solo, but for real multi-user email (verification,
magic-link sign-in, password reset) you need real delivery: set
`TEXTCASTER_SMTP_URL` (and `TEXTCASTER_MAIL_FROM`) in `.env` to a real SMTP
server, e.g. `smtps://user:pass@smtp.example.com:465`, and redeploy.

## Architecture

`core` is a headless Hono/Node service backed by SQLite (`better-auth` for
identity/sessions) that serves feeds, federation endpoints (WebSub, rssCloud),
and the timeline API; `web` is the SvelteKit app — the UI, and the only
thing browsers ever talk to, proxying auth and streaming to core server-side.
In production, Caddy sits in front of both: it terminates HTTPS and routes
core's small **public** surface (feed/OPML XML, federation callbacks)
directly to `core`, sending everything else — including all auth — to `web`,
while `core` itself publishes no host ports and is reachable only through
that front door.

## Docs

- [`docs/superpowers/specs/`](docs/superpowers/specs/) — design documents for
  every major piece (spine, feeds, following, threading, auth, Docker, email,
  and more).
- [`docs/superpowers/documentation/RUNNING.md`](docs/superpowers/documentation/RUNNING.md) —
  running Textcaster without Docker (npm workspaces directly), full env var
  reference, and identity/session/email details.

## Credits and lineage

The name is an attribution. Textcaster stands on ideas and standards it did
not invent:

- **Dave Winer** and [textcasting.org](https://textcasting.org) — the
  Textcasting manifesto, RSS, OPML, rssCloud, and the
  [rss.chat](https://github.com/scripting/rss.chat) idea this reimagines.
- **The IndieWeb community** — Micropub, Webmention, IndieAuth, and
  microformats2.
- **JSON Feed** — Manton Reece and Brent Simmons.
- **WebSub** and the broader open-feed ecosystem.

Textcaster's job is to make these work together, credited, in one place.

## License

Not yet chosen — a license will be picked before the first release.
