# Textcaster Carta Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both compose surfaces upgrade from bare `<textarea>` to Carta (syntax-highlighted Markdown editing + live preview) as a pure progressive enhancement — no-JS posting, form actions, wire, and server sanitization untouched.

**Architecture:** One `MarkdownComposer.svelte`: SSR renders the plain textarea; on mount a dynamic import of `carta-md` resolves and a post-mount `$state` flag swaps in `<MarkdownEditor>` whose OWN textarea carries the form semantics (`textarea={{ name, required }}` — probed prop spread), one `$state` value binding both branches. No hidden mirror. DOMPurify sanitizes Carta's client-side preview; the server display path is untouched. First: both server sanitizer configs widen symmetrically with benign GFM tags (`table thead tbody tr td th del`) so preview/display/feeds agree (H3).

**Tech Stack:** carta-md 4.11.2 (Svelte 5 native — probed: `MarkdownEditor` props `carta/value/mode/placeholder/textarea`, `TextAreaProps` includes `name`/`required`/`form`; `Carta` constructor REQUIRES `sanitizer`), dompurify 3 (bundled types), both ALREADY INSTALLED in web.

**Spec:** `docs/superpowers/specs/2026-07-16-textcaster-carta-composer-design.md` (rev 2, d74fa99).

## Global Constraints

- **The form contract is the invariant:** existing form-action tests (`web/src/routes/page.actions.test.ts`) must pass UNMODIFIED — any edit to them is a design violation. Field names, actions, redirects unchanged.
- **H4 hydration rule:** the editor swap is gated on a POST-MOUNT `$state` flag flipped after the dynamic import resolves — never on `browser`. SSR and first client render both show the plain textarea.
- **`mode="tabs"` pinned** (narrow-sidebar composer; `auto` split-view is wrong there).
- **Sanitizer widening is tags-only** — `table thead tbody tr td th del` added to BOTH configs (core `markdown.ts`, web `render.ts`, symmetric, drift-canary fixtured); the attribute allowlist is untouched; task-list `input` NEVER survives (fixtured).
- **Bundle gate:** carta-md must appear only as a `dynamicImports` edge in `web/.svelte-kit/output/client/.vite/manifest.json` — never a static `imports` edge.
- Shared checkout: NEVER `git add -A`. All four gates green at each task's end. Commit trailer:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File structure

```
core/src/domain/markdown.ts        # MODIFY: +7 GFM tags (T1)
web/src/lib/server/render.ts       # MODIFY: +7 GFM tags (T1)
core/test/rich-content.test.ts     # MODIFY: parity fixtures (T1)
web/src/lib/server/render.test.ts  # MODIFY: parity fixtures (T1)
web/src/lib/MarkdownComposer.svelte # CREATE (T2)
web/src/routes/+page.svelte        # MODIFY: home composer swap (T2)
web/package.json, package-lock.json # MODIFY: deps (already installed; committed T2)
web/src/routes/post/[id]/+page.svelte # MODIFY: reply composer swap (T3)
web/src/routes/post/[id]/reply.actions.test.ts # CREATE (T3)
web/src/app.css                    # MODIFY: Carta theming block (T3)
scripts (inline in T4): bundle-gate check; RUNNING.md note (T4)
```

---

### Task 1: GFM parity — widen both sanitizer configs (H3)

**Files:**
- Modify: `core/src/domain/markdown.ts`, `web/src/lib/server/render.ts`, `core/test/rich-content.test.ts`, `web/src/lib/server/render.test.ts`

**Interfaces:**
- Produces: both `SANITIZE_CONFIG`s allow `table thead tbody tr td th del` (tags only). Nothing else changes.

- [ ] **Step 1: Failing fixtures** — append to `web/src/lib/server/render.test.ts`:

```ts
test('GFM parity: tables and strikethrough survive; task-list checkboxes never do', () => {
	const table = renderPostHtml(local('| a | b |\n| - | - |\n| 1 | 2 |'))
	expect(table).toContain('<table>')
	expect(table).toContain('<td>1</td>')
	expect(renderPostHtml(local('~~gone~~'))).toContain('<del>gone</del>')
	const task = renderPostHtml(local('- [ ] never a checkbox'))
	expect(task).not.toContain('<input')
	expect(task).toContain('never a checkbox') // degrades to text, not silence
})
```

And append to `core/test/rich-content.test.ts` (the drift-canary mirror, against `renderLocalHtml`):

```ts
test('GFM parity mirror: tables/del survive, checkbox inputs never (drift canary)', () => {
  const table = renderLocalHtml('| a | b |\n| - | - |\n| 1 | 2 |')
  expect(table).toContain('<table>')
  expect(table).toContain('<td>1</td>')
  expect(renderLocalHtml('~~gone~~')).toContain('<del>gone</del>')
  expect(renderLocalHtml('- [ ] never a checkbox')).not.toContain('<input')
})
```

- [ ] **Step 2: Run — verify RED**

Run: `npm test -w web && npm test -w core`
Expected: FAIL — `<table>` stripped by both configs today.

- [ ] **Step 3: Widen both configs identically.** In `core/src/domain/markdown.ts` AND `web/src/lib/server/render.ts`, the `allowedTags` array becomes:

```ts
  allowedTags: ['p', 'br', 'a', 'em', 'strong', 'b', 'i', 'blockquote', 'code', 'pre', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'del'],
```

(Nothing else in either config changes — attributes, schemes, transformTags, `allowProtocolRelative: false` all stay.)

- [ ] **Step 4: Run — verify GREEN (all four gates)**

Run: `npm test -w web && npm run check -w web && npm test -w core && npm run typecheck -w core`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add core/src/domain/markdown.ts web/src/lib/server/render.ts core/test/rich-content.test.ts web/src/lib/server/render.test.ts
git commit -m "$(printf 'core+web: GFM tables and strikethrough survive the sanitizers (tags-only widening)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 2: `MarkdownComposer.svelte` + home composer swap

**Files:**
- Create: `web/src/lib/MarkdownComposer.svelte`
- Modify: `web/src/routes/+page.svelte`, `web/package.json`, `package-lock.json` (deps already installed — this commit records them)

**Interfaces:**
- Produces: `<MarkdownComposer placeholder name? required? />` — renders `<textarea name="content" …>` SSR; swaps to Carta post-import. Consumed by Task 3's reply surface identically.
- Consumes: carta-md 4.11.2 (probed API), dompurify.

- [ ] **Step 1: The component** — create `web/src/lib/MarkdownComposer.svelte`:

```svelte
<script lang="ts">
	import type { Component } from 'svelte'

	let {
		name = 'content',
		placeholder = '',
		required = true
	}: { name?: string; placeholder?: string; required?: boolean } = $props()

	// One value binds BOTH branches: whatever was typed pre-enhancement seeds
	// the editor; Carta's own textarea then carries the form semantics.
	let value = $state('')

	// Post-mount flag (H4): never gate on `browser` — SSR and the first client
	// render must both show the plain textarea or hydration mismatches. The
	// swap happens only after carta-md's dynamic import resolves; on import
	// failure the flag never flips and the plain textarea IS the composer.
	let editor = $state<{ MarkdownEditor: Component; carta: unknown } | null>(null)

	$effect(() => {
		let cancelled = false
		Promise.all([import('carta-md'), import('dompurify'), import('carta-md/default.css')])
			.then(([cartaMod, dompurifyMod]) => {
				if (cancelled) return
				const carta = new cartaMod.Carta({
					// Preview runs client-side on pasteable input — paste-based
					// self-XSS is real. Display sanitization stays server-side.
					sanitizer: (html: string) => dompurifyMod.default.sanitize(html)
				})
				editor = { MarkdownEditor: cartaMod.MarkdownEditor as unknown as Component, carta }
			})
			.catch(() => {})
		return () => {
			cancelled = true
		}
	})
</script>

{#if editor}
	{@const MarkdownEditor = editor.MarkdownEditor}
	<MarkdownEditor carta={editor.carta} mode="tabs" {placeholder} textarea={{ name, required }} bind:value />
{:else}
	<textarea {name} {placeholder} {required} bind:value></textarea>
{/if}
```

(If `MarkdownEditor`'s prop typing fights the generic `Component` cast, type `editor` as `{ MarkdownEditor: any; carta: any }` with a one-line comment — the dynamic-import indirection is the point; runtime shape is probed.)

- [ ] **Step 2: Home swap** — in `web/src/routes/+page.svelte`: add `import MarkdownComposer from '$lib/MarkdownComposer.svelte'` and replace

```svelte
				<textarea name="content" placeholder="what's happening?" required></textarea>
```
with
```svelte
				<MarkdownComposer placeholder="what's happening?" />
```

- [ ] **Step 3: Gates — the contract check is the point**

Run: `npm test -w web && npm run check -w web`
Expected: PASS with `page.actions.test.ts` UNMODIFIED (verify: `git diff --stat web/src/routes/page.actions.test.ts` is empty). svelte-check 0 errors/0 warnings.

- [ ] **Step 4: SSR markup check** (dev server running):

Run: `curl -s http://localhost:5173/ | grep -c 'name="content"'`
Expected: `1` — the SSR half of the contract: the plain named textarea is in the pre-hydration markup.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/MarkdownComposer.svelte web/src/routes/+page.svelte web/package.json package-lock.json
git commit -m "$(printf 'web: Carta markdown composer — progressive enhancement, form-native textarea\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 3: reply composer swap + reply-action test + theming

**Files:**
- Modify: `web/src/routes/post/[id]/+page.svelte`, `web/src/app.css`
- Create: `web/src/routes/post/[id]/reply.actions.test.ts`

**Interfaces:**
- Consumes: Task 2's `MarkdownComposer`.
- Produces: the reply action gains its missing contract test (both surfaces gated).

- [ ] **Step 1: The reply-action test FIRST** (it pins today's behavior and must survive the swap untouched) — create `web/src/routes/post/[id]/reply.actions.test.ts`:

```ts
import { test, expect, vi } from 'vitest'
import { actions } from './+page.server.ts'

function formRequest(fields: Record<string, string>): Request {
	const body = new URLSearchParams(fields)
	return new Request('http://x/?/reply', { method: 'POST', body })
}

test('reply posts content with the viewed post as target and redirects', async () => {
	const fetch = vi.fn(async () => new Response(null, { status: 201 }))
	await expect(
		actions.reply({ request: formRequest({ handle: 'alice', content: 'a reply' }), fetch, params: { id: 'post-1' } } as never)
	).rejects.toMatchObject({ status: 303 })
	const body = JSON.parse(String(fetch.mock.calls[0][1]?.body))
	expect(body.content).toBe('a reply')
	expect(body.inReplyTo).toBe('post-1')
})

test('reply fails without content', async () => {
	const fetch = vi.fn()
	const res = await actions.reply({ request: formRequest({ handle: 'alice' }), fetch, params: { id: 'post-1' } } as never)
	expect(res).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})
```

Run: `npm test -w web` — Expected: PASS immediately (it pins EXISTING behavior; if it fails, the test's assumptions are wrong — check `+page.server.ts`'s actual action shape and fix the TEST, reporting what differed).

- [ ] **Step 2: Reply swap** — in `web/src/routes/post/[id]/+page.svelte`: import `MarkdownComposer` and replace

```svelte
			<textarea name="content" placeholder="write a reply" required></textarea>
```
with
```svelte
			<MarkdownComposer placeholder="write a reply" />
```

- [ ] **Step 3: Theming** — append to `web/src/app.css`:

```css

/* Carta composer — skin the editor with our tokens (both themes come from
   the variables themselves). Arrives only on composer pages (dynamic import). */

.carta-editor {
	background: var(--color-surface);
	border: 1px solid var(--color-border);
	border-radius: 8px;
	font-family: inherit;
}

.carta-toolbar {
	border-bottom: 1px solid var(--color-border);
	color: var(--color-secondary);
}

.carta-toolbar .carta-active {
	color: var(--color-accent);
}

.carta-icon:hover {
	background: var(--color-muted);
	color: var(--color-foreground);
}

.carta-input,
.carta-renderer {
	color: var(--color-foreground);
	padding: var(--space-sm);
	min-height: 7rem;
}

.carta-input textarea {
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	font-size: 0.9375rem;
	color: inherit;
	background: none;
	border: 0;
}

.carta-renderer {
	font-size: 0.9375rem;
}
```

- [ ] **Step 4: Gates**

Run: `npm test -w web && npm run check -w web && npm test -w core && npm run typecheck -w core`
Expected: all green; `page.actions.test.ts` and the new `reply.actions.test.ts` both untouched by the swap (`git diff --stat` on both after Step 2 shows only the new file's creation).

- [ ] **Step 5: Commit**

```bash
git add "web/src/routes/post/[id]/+page.svelte" "web/src/routes/post/[id]/reply.actions.test.ts" web/src/app.css
git commit -m "$(printf 'web: Carta on the reply composer + token theming; reply action gains its contract test\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 4: bundle gate + SSR verification + RUNNING.md

**Files:**
- Modify: `docs/superpowers/documentation/RUNNING.md`

- [ ] **Step 1: Bundle gate (concrete).** Build and assert carta-md is lazy:

```bash
npm run build -w web && node --input-type=module -e "
import { readFileSync } from 'node:fs'
const manifest = JSON.parse(readFileSync('web/.svelte-kit/output/client/.vite/manifest.json', 'utf8'))
const entries = Object.entries(manifest)
const cartaChunks = entries.filter(([k]) => k.includes('carta')).map(([k]) => k)
const staticImporters = entries.filter(([, v]) => (v.imports ?? []).some((i) => i.includes('carta')))
const dynamicImporters = entries.filter(([, v]) => (v.dynamicImports ?? []).some((i) => i.includes('carta')))
console.log('carta chunks:', cartaChunks.length, '| static importers:', staticImporters.length, '| dynamic importers:', dynamicImporters.length)
if (staticImporters.length > 0) { console.error('FAIL: carta statically imported by', staticImporters.map(([k]) => k)); process.exit(1) }
if (dynamicImporters.length === 0 && cartaChunks.length === 0) { console.error('FAIL: carta not found in manifest at all'); process.exit(1) }
console.log('BUNDLE GATE PASS')
"
```
Expected: `BUNDLE GATE PASS`, zero static importers.

- [ ] **Step 2: SSR verification** (dev servers running): both composer pages carry the plain named textarea pre-hydration:

```bash
curl -s http://localhost:5173/ | grep -c 'name="content"'   # expect 1
POST_ID=$(curl -s 'http://localhost:8787/timeline?limit=1' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).timeline[0].id))")
curl -s "http://localhost:5173/post/$POST_ID" | grep -c 'name="content"'   # expect 1
```

- [ ] **Step 3: RUNNING.md** — in Feature notes, extend the Markdown-compose bullet: with JavaScript on, composing gets a Markdown editor with live preview (Carta); without it, the same plain textarea as always — posts are identical either way.

- [ ] **Step 4: Whole-milestone gates**

Run: `npm test -w core && npm run typecheck -w core && npm test -w web && npm run check -w web`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/documentation/RUNNING.md
git commit -m "$(printf 'docs: Carta composer note — markdown editing with live preview, plain textarea baseline\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** H3 tags-only widening + fixtures both configs → T1; form-native textarea contract, H4 post-mount flag, mode="tabs", DOMPurify preview sanitizer, dynamic import, import-failure baseline → T2; reply surface + missing reply-action test + token theming (probed class names: .carta-editor/-toolbar/-input/-renderer/-icon/-active) → T3; concrete manifest bundle gate + SSR checks + RUNNING.md → T4. Non-goals absent (no plugins, drafts, editing). Human click-check remains post-milestone (obscura cannot settle dynamic imports — controller/user step, noted in spec).
- **Placeholder scan:** all code complete; the one typing escape hatch (Component cast) states its fallback concretely. ✅
- **Type consistency:** `MarkdownComposer` props identical T2/T3; test idioms mirror the probed `page.actions.test.ts` shape (formRequest/`as never`); reply test asserts the probed action contract (JSON body `content` + `inReplyTo` from `params.id`). ✅
- **Probe-accuracy:** carta-md 4.11.2 installed + API read from its shipped `.d.ts` (textarea prop spread incl. name/required, mode values, sanitizer required on constructor); CSS class names from `default.css`; dompurify installed (bundled types).
