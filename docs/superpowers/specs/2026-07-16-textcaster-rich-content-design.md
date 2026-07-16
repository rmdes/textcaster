# Textcaster — rich content rendering design (UI-6)

Date: 2026-07-16
Status: design approved (brainstorm); spec pending review
Author: Ricardo (rmdes) with Claude Code
Basis: Textcasting contract (Markdown+HTML dual content;
source.scripting.com: a presenter that understands Markdown SHOULD prefer
`source:markdown` for display); rss.chat client worknotes 7/6–7/7/26
(blockquote/heading/code lessons). Probed: feedsmith parses AND emits
`sourceNs.markdown`.

## What this ships

Post bodies render rich — blockquotes, heading hierarchy, code, lists,
links, images — replacing plaintext-everything, with ONE server-side render
path and the Textcasting dual-content contract on our own feeds.

Decisions (brainstormed):

- **Sanitization is render-time, in web SSR.** Core stores and re-emits raw
  content (pass-through stays byte-faithful); the browser only ever
  receives sanitized HTML.
- **Full dual contract**: incoming `source:markdown` is the preferred
  display source; local composes are Markdown; our feeds emit
  `source:markdown` + rendered `<description>`.
- **New dependencies (user-approved)**: `sanitize-html` (web only) and
  `marked` (core + web, same version; GFM so bare URLs autolink).
- **Images allowed** in post bodies (rss.chat posts carry them; the clamp
  bounds jank), http(s)-only + `loading="lazy"`.

## Data model — migration 7

```sql
ALTER TABLE posts ADD COLUMN content_markdown TEXT; -- source:markdown verbatim (remote); null otherwise
```

- Remote items: `ParsedItem` gains `contentMarkdown: string | null` from
  `item.sourceNs.markdown` (RSS path; other formats null). Stored verbatim.
  Backfill on re-poll: the existing `backfillSourceAttribution` method is
  renamed `backfillItemExtras` and gains the field — one method, one
  UPDATE, filling `source_name`/`source_feed_url`/`content_markdown`
  only where currently null (same no-flapping rule, contract-pinned).
- Local posts: `content` IS the Markdown source; `content_markdown` stays
  null (locals are implicitly Markdown by `source === 'local'`). Existing
  local dev posts are plain text — valid Markdown, renders equivalently.

## Display precedence (the whole rule)

Per post: `content_markdown` present → render as Markdown; else
`source === 'local'` → render `content` as Markdown; else render `content`
as HTML. Every path ends in the sanitizer.

## The one render path — `web/src/lib/server/render.ts`

```ts
renderPostHtml(post: { content: string; contentMarkdown?: string | null; source: 'local' | 'remote' }): string
```

- Markdown branches: `marked` with GFM (autolinks bare URLs); HTML branch:
  the content string as-is. BOTH then flow through `sanitize-html`.
- Allowlist: `p br a em strong b i blockquote code pre ul ol li h1 h2 h3 h4 img`.
  Attributes: `a[href]` and `img[src]` http(s)-only (scheme-checked by the
  sanitizer config), `rel="noreferrer"` forced on every `a`,
  `loading="lazy"` forced on every `img`; every other attribute stripped
  (no class, no style, no on*).
- Lives under `lib/server/` so SvelteKit build-fails any client import —
  the sanitizer never ships to (or runs in) the browser.

**Enrichment at the two ingress points** — the browser never sees raw
content:

1. Page `load` functions (home, lenses, thread page): map each entry to
   include `contentHtml = renderPostHtml(entry)`.
2. The `/stream` SSE proxy: parse each upstream `post` event's JSON, add
   `contentHtml`, re-serialize, forward. (The proxy already exists; this is
   a transform in its pipe. Event id/name pass through unchanged so replay
   semantics are untouched.)

Wire type: `TimelineEntry` (web) gains `contentHtml?: string`. The
`{@html}` chokepoint gets a concrete home: a new `PostBody.svelte`
(the body `<p class="body">`-equivalent: `{@html}` + the clamp handler +
the plaintext fallback), and ALL FIVE render sites (home, two lenses,
thread page, ReplyTree) use it — `{@html}` appears in exactly one
component in the codebase, fed only by `render.ts` output. This also
retires the five duplicated body blocks (a first slice of the ledgered
post-card dedup). `plaintext()`/`Linkified` remain for excerpt contexts.

**Fallback**: entries missing `contentHtml` (shouldn't happen — both
ingress points enrich) render via `plaintext()` as today, never raw.

## Feeds out (core) — the dual contract

Local posts, in `renderRssFeed`/`renderCommentsFeed` item mapping and the
JSON Feed equivalent:

- `<description>` = `marked(content)` (rendered HTML — readers that don't
  know `source:markdown` still see rich content).
- `<source:markdown>` = raw `content` (probed: feedsmith serializes
  `sourceNs.markdown`).
- JSON Feed: `content_html` = rendered, `content_text` = raw content
  (replacing today's text-only mapping for local posts).

Remote posts re-emit exactly as stored: `description` = `content`
untouched, plus `<source:markdown>` = `content_markdown` when present
(pass-through both fields). Core does NOT sanitize — feeds carry the
author's original; display sanitization is the consumer's job (ours lives
in web).

`marked` is core's only new dependency; web adds `marked` + `sanitize-html`.

## Styling (web, tokens only — design pass refines)

Scoped inside `.post .body`, per rss.chat's 7/6–7/7 lessons:

- `blockquote`: thin left rule (`--color-border`), muted text
  (`--color-secondary`), body-size type — "someone else's words", not
  Bootstrap dress.
- `h1–h4`: real hierarchy scaled WITHIN the post body (post titles stay the
  page's h2/h3 — body headings must not outshout them).
- `code`/`pre`: small monospace stack, `--color-muted` background;
  `pre` scrolls horizontally rather than breaking layout.
- `img`: `max-width: 100%`, height auto.
- Click-to-expand clamp: unchanged — `max-height` works on rich HTML, and
  the link-click guard in `toggleClamp` already exempts anchors.

## Security invariants (tested, not asserted)

1. Allowlist-only sanitizer; `script`, `style`, `iframe`, `svg`, event
   handlers, `class`/`style` attributes never survive.
2. `href`/`src` http(s)-only — `javascript:`, `data:`, `vbscript:` dropped.
3. `{@html}` single chokepoint fed only by `render.ts`.
4. Hostile-fixture unit tests: `<script>`, `<img onerror>`,
   `javascript:` hrefs, `data:` srcs, nested/malformed markup, an SVG
   payload, and a Markdown document that EMBEDS raw HTML (marked passes
   raw HTML through — the sanitizer must catch it; this fixture is the
   load-bearing one).

## Testing

- `render.ts`: precedence matrix (markdown column / local / remote HTML) +
  the hostile fixtures above + autolink pin.
- Stream proxy: an upstream `post` event gains `contentHtml`; id/event
  fields byte-identical (replay untouched).
- Core: local markdown post → feed carries rendered `<description>` +
  verbatim `<source:markdown>`; JSON Feed carries `content_html` +
  `content_text`; remote posts re-emit untouched (pass-through pin);
  `content_markdown` ingest + backfill pins; migration 6→7 pin.
- Live: obscura SSR check on real rss.chat content (Dave's quote-heavy
  posts) — blockquote/heading/code elements present, script-free.

## Non-goals

Media enclosure UI, iframes/embeds (stripped), image uploads, syntax
highlighting, editing, sanitizer caching (render-per-request until it
measurably matters — `ponytail:` ceiling).

## Sequencing

1. Core: migration 7 + `contentMarkdown` ingest/backfill + dual-contract
   feed emission (with tests).
2. Web: `render.ts` + hostile fixtures; enrichment at both ingress points;
   `{@html}` swap in the post-body component sites; styling.
3. Obscura verification on live data + RUNNING.md note.
