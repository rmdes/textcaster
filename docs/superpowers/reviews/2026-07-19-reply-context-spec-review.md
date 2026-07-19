# Spec review — reply-context from embedded h-cite (2026-07-19, rev 1 = 8c4c5e9)

High-effort review: 8 finder angles × adversarial verification, every claim
checked against the installed `@paulrobertlloyd/mf2tojf2` source, core, and web.
10 findings survived verification; 3 candidates were refuted. Ranked most
severe first. **Verdict: fold as rev 2 before writing-plans** — nothing kills
the design, but F1–F4 change spec text an implementer would follow into bugs.

## The two flagged product calls — answered

1. **Author verbatim, no fabricated `@`** — **keep.** Correct and honest: the
   source's `author.name` may be a display name, a handle, or (verified in
   `flatten-items.js:61-62`) a plain string from a text-only `p-author`; the
   spec's string-or-card branch is a real post-flatten shape, not dead code.
   Fabricating `@` would assert an identity scheme h-feeds don't carry.
2. **No "as quoted" disclaimer** — **keep**, with one honesty edit: safeguard 1
   ("the moment the parent lands, context is not shown") is only true
   per-pageload — see F7. Soften the claim (or add the emit); the no-disclaimer
   posture itself is fine given the attributive phrasing + plain-text render.

## Findings

### F1 — Multi-cite `in-reply-to` flattens to `{children:[...]}`, which parseInReplyTo misreads (spec §1, line 60)

**CONFIRMED.** When an entry replies to 2+ h-cites, `flattenItems`
(`flatten-items.js:87-88` → `getChildren`, line 41) returns
`{ children: [cite, cite] }` — an object, not an array. The helper's
`Array.isArray(irt) ? irt[0] : irt` passes the wrapper into the cite branch;
`url`/`author`/`content` are all `undefined` → `ref=null` → the reply orphans
with no context — the exact bug the spec fixes, on a real library shape.
(Mixed-first-string multi-values DO return a raw array and work.)
**Fix:** unwrap first: `if (irt && typeof irt === 'object' && Array.isArray((irt as any).children)) irt = (irt as any).children[0]` (or equivalent), + a test.

### F2 — `cite.url` can be an array; the typeof-string check no-ops the fix (spec §1, line 64)

**CONFIRMED.** A cite with multiple `u-url` values flattens to
`url: [string, string]` (`flatten-items.js:101` fall-through), so
`typeof cite.url === 'string'` fails → `ref=null` → still orphans.
**Fix:** `const ref = typeof cite.url === 'string' ? cite.url : Array.isArray(cite.url) && typeof cite.url[0] === 'string' ? cite.url[0] : null`, + a test.

### F3 — Already-stored orphans never heal: no backfill/update path (spec §3, line 109)

**CONFIRMED.** Pre-feature replies stored with `in_reply_to = null` (their
object-form ref was discarded) take the already-seen else-branch on re-poll
(`ingest.ts:170-187`), and `backfillItemExtras` (`sqlite.ts:317-331`) COALESCEs
only `source_name, source_feed_url, content_markdown, url` — neither the thread
ref nor the context columns. So the headline threading fix applies to **newly
ingested** replies only; existing orphans stay orphaned forever. The spec
should either (a) extend `backfillItemExtras` with COALESCE on
`in_reply_to`/`reply_context_*` (+ re-run adoption when a ref appears), or
(b) state the new-items-only scope honestly as a boundary.
Related implementer checklist (the "rides along" wording undersells it): the
flow needs hand edits at FOUR literals — the `Post` object (`ingest.ts:158-165`),
`insertPost .values` (`sqlite.ts:181`), `rowToPost` (`sqlite.ts:20-21`), and
`PostsTable` (`sqlite.ts:9`) — miss one and the feature is a silent no-op.
(Fresh-schema is NOT a fifth site: fresh DBs replay all migrations,
`sqlite.ts:648-653`.)

### F4 — Rev-1's ".source already has the styling" premise is false on the timeline (spec §4, line 158)

**CONFIRMED.** `web/src/app.css:404-406`: `.post .source { font-size: 0.875rem }`
— **font-size only**; its color comes from the global
`a { color: var(--color-accent) }` (app.css:62). And `.source` sits on the
`<a>` itself, so the spec's plain-text author/snippet nodes outside the anchor
would render at default body size/color. `.subnav` on post-detail genuinely
carries `--color-secondary`/0.875rem (`app.css:463-466`) and wraps the text —
that half holds. **Fix:** rev-1 cut #2 needs a partial revert for the timeline:
one small wrapping class (e.g. `.reply-context { color: var(--color-secondary);
font-size: 0.875rem }`) or wrap in an existing muted block class — "no new CSS"
cannot produce the mandated muted line there.

### F5 — Author-only render is unspecified and the literal template violates the spec's own rule (spec §4, line 128)

**CONFIRMED.** Rev-1 cut #3 makes author-present/snippet-null a routine state
(h-cite with author + url, no content — also produced by F2's html-only
content case). §4 defines only the full template and the
neither-author-nor-snippet fallback; applying the sole template literally
renders `In reply to aaronpk: “”` — exactly what Error-handling line 214
forbids ("an empty snippet never renders “”"). **Fix:** specify the author-only
variant explicitly: `In reply to {author} ↗` (no colon, no quotes).

### F6 — §4 names 2 of the 4 unresolved-reply render surfaces (spec §4, line 119)

**CONFIRMED.** The `!inReplyToPostId && startsWith('http')` affordance also
exists at `web/src/routes/u/[handle]/+page.svelte:124` and
`web/src/routes/u/[handle]/following/+page.svelte:126`. As written the profile
and following timelines silently keep the bare link (no regression, but
inconsistent enrichment) — and any future template fix must be replicated in
4 hand-written copies of a security-sensitive render. **Fix:** list all four
surfaces, and keep the four copies textually identical.
(`ReplyTree.svelte` shows only resolved replies — correctly out of scope.)

### F7 — "The moment the parent lands, context is not shown" is only true per-pageload (Trust posture 1, line 186)

**CONFIRMED.** `adoptOrphans` runs at `ingest.ts:167`, but `emitNewPost` fires
only for the inserted parent — never for the adopted orphan rows. A live SSE
timeline keeps rendering the unverified context until reload. Notably the swap
mechanism already exists (`live.ts:12-13` `mergeIncoming` overlays by id), so
one emit for adopted rows would make the claim literally true — or soften the
spec text to "on next load". Either is acceptable; don't leave the overstated
claim.

### F8 — Trust boundary is enforced render-side in N places, not once at serialization (spec §5, line 164)

**CONFIRMED (altitude).** `{...e}` spread (`api/app.ts:395`), SSE
`JSON.stringify(entry)` (:408), and getThread all ship `reply_context_*` for
**resolved** replies too; nothing server-side drops the untrusted claim once
the real parent is known. Every surface (4 today, F6) must independently
remember the `!inReplyToPostId` gate. Nulling the two fields at serialization
when `inReplyToPostId` is set would enforce "the real post always wins" once,
structurally — and shrinks F6's fragility. Recommended, small (one map in the
timeline/thread/SSE entry shaping or in `rowToPost`'s consumer).

### F9 — `truncate` re-implements truncation less safely than the codebase's own idiom (spec §1, line 80)

**CONFIRMED.** `feed.ts:200` already truncates code-point-safely with the
comment "code-point safe: .length/.slice on a string split surrogate pairs" —
the spec's `t.slice(0, 200)` is exactly that bug (emoji at the boundary →
broken half-codepoint before the `…`). Also order: `s?.trim()` before slicing
copies a potentially multi-MB hostile string (feeds bounded only by
`MAX_FEED_BYTES` = 5 MB, `ingest.ts:29`); slice a bounded prefix first.
**Fix:** `Array.from`-based cut per the feed.ts idiom, slice-before-trim.

### F10 — toParsedItem grows to 12 positional params with filler args and a silent-swap hazard (spec §1, line 84)

**CONFIRMED.** Real signature (`ingest.ts:56`) already ends
`source?, contentMarkdown=null, updatedAt=null`; the h-feed call site
(`discovery.ts:56`) passes 7 args, so reaching positions 11-12 forces
`undefined, null, null` filler — and the two new params are adjacent,
same-typed (`string | null`), silently swappable at every call site.
Acceptable if the plan spells out the exact call; better: pass the two context
values as one optional trailing object param, or fold them into the existing
`source`-style options. Flag for the plan, not a blocker.

## Minor notes (no findings)

- §5's `core/src/app.ts` references should read **`core/src/api/app.ts`**
  (file verified absent at the old path; line numbers otherwise match).
- The claimed `content: {html, text}` shape is overstated: `getHtml`
  (`flatten-items.js:30-33`) omits `text` when the mf2 `value` is falsy, so
  html-only content yields snippet `null` → degrades to F5's author-only line.
  Worth one sentence in §1.
- Refuted during verification (for the record): the "unreachable no-URL
  branch" candidate — §4 line 124 explicitly directs the guard change, and
  "reuse existing" scopes to CSS only. Residual trap: an implementer who
  copies the existing `{#if …startsWith('http')}` verbatim and only swaps the
  body silently kills the no-URL case; the plan should quote the NEW guard
  (`!inReplyToPostId && (context || httpUrl)`) explicitly.
- The two ingest-level threading tests (§ Testing) exercise zero new code —
  `ingestItems` sees only a plain string ref either way; the discovery-level
  assertion is the new thing. Keep at most one as an integration smoke test.
- Hono-skill mandate: §5 concludes zero HTTP-layer changes (verified true);
  the `hono` skill still fires at implementation time per CLAUDE.md if any
  route/test is touched.
