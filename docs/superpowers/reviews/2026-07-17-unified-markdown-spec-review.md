# Spec review — unified markdown pipeline (2026-07-17)

## Re-review — rev 2 (2aafab6): CLEAN, ready to plan

Rev 2 landed every finding below (verified against the `2ab3fe3..2aafab6`
diff, not asserted):
- `allowedClasses` declared the WHOLE mechanism; `class` MUST NOT enter
  `allowedAttributes` (the probed footgun is now an explicit prohibition).
  Security delta reworded to "one `allowedClasses` line per twin."
- Bare `hljs*` glob justified against rehype-highlight's bare `class="hljs"`;
  highlight.js sub-scope stripping (`function_`) pinned as expected/do-not-fix.
- `allowDangerousHtml` framed as "never opt in — default already drops raw
  HTML at the parser"; `<script>`-inline fixture retained.
- `remark-emoji accessible:false` pinned + bare-text fixture; `detect:false`
  unlabeled-fence behavior and node-emoji-vs-`@cartamd/plugin-emoji` map
  divergence both named as bounded residuals to probe at plan time.
- Byte-identity treated as new work, enforced by EXACT identical version pins
  across both `package.json` (hoisted-root dedupe).
- Ponytail flag answered: the load-bearing goal is declared as **remark-
  ecosystem compatibility** (marked+extensions only covers plugins with marked
  ports and re-opens parity on every future plugin), and the core swap is made
  a conscious feed==site product property, not reflex.

**Green light — write the implementation plan.** One item to carry in as a
concrete plan task (the spec already implies it): probe carta-md 4.11.2's
installed source for the preview transformer wiring and compare the emoji
shortcode sets — real steps, not memory calls.

---

## Original review — rev 1 (2ab3fe3)

Ponytail + security + correctness. Every claim below is grounded in a file
read or a live probe against the installed libraries (probes run from the repo
root for module resolution; the 3 uninstalled plugins probed in a throwaway
npm dir at carta-compatible versions).

**Verdict: READY TO PLAN.** The two-line security delta the operator flagged is
verified safe. The `processSync` hard constraint holds for all 7 plugins. One
spec-wording correction (allowedClasses, not allowedAttributes) and four
plan-time pins below — none is a blocker.

---

## Security — the delta is exactly two lines, both verified SAFE

### (i) `allowedClasses` widening — safe and genuinely narrow

Probe (`sanitize-html@2.17.6`, the installed version) with
`allowedClasses: { code: ['hljs*','language-*'], span: ['hljs-*'] }` and `class`
deliberately NOT in `allowedAttributes`:

| input | output | verdict |
|---|---|---|
| `<code class="hljs language-js hljs-evil">` | `class="hljs language-js hljs-evil"` | kept (all match `hljs*`/`language-*`) |
| `<span class="hljs-keyword hljs-evil notallowed">` | `class="hljs-keyword hljs-evil"` | `notallowed` stripped |
| `<div class="hljs-keyword">` | class **dropped** | ✓ dies on div |
| `<a href=… class="hljs-x">` | href kept, class **dropped** | ✓ dies on a |
| `<span class="language-js">` | class **dropped** | ✓ per-tag: `language-*` is code-only |

The widening is safe because `class` is an inert attribute — no script, URL, or
style surface — and it is pattern- + tag-constrained, so an attacker cannot
inject an arbitrary or executable value. The `hljs*` glob (matching `hljs-evil`)
buys an attacker nothing: an unstyled class name does nothing, and the only CSS
rules we author target `hljs-*` tokens. Note `hljs*` on `code` is *deliberately*
right, not merely loose — rehype-highlight puts a **bare** `class="hljs"` on the
`<code>` element (verified in the chain output below), which `hljs-*` would miss;
`hljs*` catches it.

**CORRECTION (spec line 66):** the spec says "`class` joins `allowedAttributes`
ONLY for `code` and `span`." That is inaccurate — the probe shows `allowedClasses`
filters class values **without** `class` being in `allowedAttributes` at all.
`allowedClasses` is the whole mechanism. The plan must implement via
`allowedClasses` ONLY and must NOT add `class` to `allowedAttributes`: doing so is
redundant, and an implementer who adds `class` to `allowedAttributes` while
dropping `allowedClasses` would allow *arbitrary* class values on code/span — a
wider surface than intended. Fix the spec wording so this can't happen.

### (ii) `allowDangerousHtml` forbidden — verified STRONGER than the old pipeline

Probe (`remark-rehype@11.1.2`, installed via carta), raw HTML written inline in
markdown, default config (no `allowDangerousHtml`):

```
in:  Raw: <script>alert(1)</script> and <div onclick="x()">hi</div> and <img src=x onerror=alert(1)>
out: <p>Raw: alert(1) and hi and </p>
```

The `<script>`, `<div onclick>`, and `<img onerror>` tags are **dropped** before
the sanitizer ever runs; only inert text leaks (`alert(1)`, `hi`). With
`allowDangerousHtml:true` (the forbidden posture) all three pass through as live
HTML. So the default is a stronger posture than marked, which passed raw HTML to
the sanitizer as the sole backstop. Here raw HTML dies at the parser AND the
sanitizer still runs — real defense in depth. The `<script>`-inline fixture the
spec mandates will pass.

One UX nuance (not security): a user who types `<div>x</div>` in markdown sees
the tag vanish and `x` remain as text. Worth a line in RUNNING.md; harmless.

### Is the delta truly only these two lines?

Yes. The only new HTML surface any enabled plugin emits is rehype-highlight's
`<code class="hljs …">` / `<span class="hljs-…">` (probed — see correctness),
which is exactly what (i) covers. remark-breaks emits `<br>` (already
allowlisted). remark-emoji emits **bare unicode text**, no wrapper (probed:
`<p>emoji 🎉 🚀</p>`, no `<span aria-label>`) — zero surface, as claimed,
PROVIDED `accessible: true` is never set (see pin 2).

---

## Correctness — the `processSync` constraint holds

`renderPostHtml` runs inside the SSE frame transformer, which cannot await, so
the entire chain must be sync or `processSync` throws. **Verified:** the full
7-plugin chain
(`remarkParse→remarkGfm→remarkBreaks→remarkEmoji→remarkRehype→rehypeHighlight→rehypeStringify`)
ran synchronously under `processSync` at `remark-breaks@4.0.0`,
`remark-emoji@5.0.2`, `rehype-highlight@7.0.2` (unified@11 stack). None is
async. Output:

```
<p>line one<br>\nline two…</p>
<p>emoji 🎉 🚀</p>
<pre><code class="hljs language-js"><span class="hljs-keyword">const</span> x = <span class="hljs-number">1</span>…
<p>raw alert(1) inline</p>   ← <script> dropped
```

Notes / plan-time pins:

1. **Version pinning (spec already flags):** web ALREADY carries the full
   unified v11 stack, deduped, via `carta-md@4.11.2` (`unified@11.0.5`,
   `remark-parse@11`, `remark-gfm@4`, `remark-rehype@11.1.2`,
   `rehype-stringify@10`). So on the WEB side the only genuinely new packages are
   `remark-breaks`, `remark-emoji`, `rehype-highlight` (+ editor `@cartamd/*`).
   Pin these to unified-11-compatible majors (the ones probed dedupe cleanly);
   pin them **identically in core and web** so the hoisted root dedupes to one
   copy — which is also what keeps the drift-canary's byte-identity honest.
2. **remark-emoji mode:** the "zero HTML surface" guarantee holds only in the
   default (`accessible: false`). `accessible: true` wraps emoji in
   `<span role="img" aria-label="…">` — new attributes the allowlist doesn't
   carry (they'd be stripped, degrading a11y). Plan must NOT enable it; pin a
   fixture asserting emoji is bare text.
3. **highlight.js sub-scope classes:** rehype-highlight emits some spans with a
   secondary non-`hljs` class, e.g. `class="hljs-title function_"`. The
   `hljs-*` glob strips `function_`, leaving `<span class="hljs-title">`.
   Harmless — our theme only styles `hljs-*` tokens — but note it so no one
   "fixes" the sanitizer to re-admit it.
4. **`marked` removal is clean:** the only two importers are the two render
   twins (`core/src/domain/markdown.ts:1`, `web/src/lib/server/render.ts:1`).
   Nothing else references it.

---

## Ponytail

The swap replaces `marked` (1 dep) with the unified/remark stack. Is it
justified, or gold-plating? Verdict: **justified — flag, don't block**, and one
decision worth a conscious yes/no.

- **All four features land on marked too — the swap buys only AST-parity.**
  breaks → `marked({breaks:true})`; emoji → `marked-emoji`; highlight →
  `marked-highlight`+`highlight.js` (sync, same core); GFM → built in. So
  marked+extensions (~3 small deps, no core toolchain) delivers the same tag
  *structure* (`<br>`, `<del>`, `<table>`, `<code class="hljs">`). The **only**
  thing the unified swap buys over that is structural agreement with carta's
  remark parser on edge cases (autolink boundaries, nested emphasis, break
  semantics) — and it hands `core` an entire mdast/hast toolchain it doesn't
  have today (core currently holds only `marked` + `sanitize-html`).
- **The spec already concedes divergence**, so it isn't chasing *perfect*
  parity: highlight uses shiki in preview vs highlight.js in published (palette
  differs), and the emoji map source differs (carta's `@cartamd/plugin-emoji`
  vs `node-emoji`). Given that, the load-bearing question is narrow: is
  *AST-structure* agreement with the remark preview a hard requirement (→ swap),
  or does "preview is a draft, server is truth" — already accepted for highlight
  colors — suffice (→ marked+extensions, materially less)? The operator approved
  the direction; the plan should state *which* goal is load-bearing rather than
  let it be inferred.
- **The one ponytail decision worth surfacing: does CORE need the swap, or only
  WEB?** Web is where the composing user's preview-vs-display parity actually
  lives. Core's engine only feeds the feed `<description>` (external/legacy
  readers). Keeping marked in core would save core ~7 deps — but it would (a)
  break the drift-canary's byte-identity and (b) make a local post's feed HTML
  diverge from its on-site HTML (no breaks/emoji in `<description>`). The spec
  chose to swap both for feed==site consistency. That's defensible; just
  confirm feed/site consistency is wanted rather than inherited by reflex.
- **Bundling is fine:** the 5-step sequencing phases engine-swap → breaks/emoji
  → highlight → editor plugins → marked removal, each independently testable.
  Not a monolith.
- **Twin-file + drift-canary** (vs a shared workspace package): user-confirmed
  earlier; at this chain length the canary is the cheaper guarantee than
  standing up a shared package. No change.

`net`: the swap doesn't shrink the diff — it's a parity feature, not
over-engineering. The only cut available is core (keep marked there), and that
trades a product property (feed==site) the spec deliberately wants. Ship as
specced once the correction + pins land.

---

## Verified sound
- Both twins' `SANITIZE_CONFIG` are byte-identical except tabs/spaces — the
  drift-canary's job. Widening applies symmetrically to both.
- `allowProtocolRelative:false`, `allowedSchemes:['http','https']`,
  forced `rel`/`loading` — untouched by this design.
- No migration needed: render-on-read, markdown stored raw.
- `{@html}` single chokepoint (PostBody.svelte) + three ingress points —
  untouched.

## What to change before/at planning
1. Correct spec line 66: mechanism is `allowedClasses`; `class` must NOT be
   added to `allowedAttributes` (security-wording fix, prevents an over-wide
   implementation).
2. Pin identical unified-11-compatible versions in BOTH workspaces (dedupe +
   byte-identity).
3. Pin remark-emoji default mode (no `accessible:true`) + fixture.
4. Note highlight.js sub-scope class stripping (`function_`) as expected.
5. Pin two parity nuances as bounded residual divergence (like the shiki-vs-
   highlight.js palette already named): (a) `rehype-highlight`'s `detect`
   defaults to `false`, so **unlabeled** fenced blocks get no `hljs` class/color
   — confirm that matches carta's shiki preview for bare fences; (b) the emoji
   map source differs (`node-emoji` published vs `@cartamd/plugin-emoji`
   preview) — confirm the shortcode sets agree or name it as residual.

Sanitizer delta, allowDangerousHtml posture, and full-chain sync are all
verified against the real libraries. Ready to write the plan.
