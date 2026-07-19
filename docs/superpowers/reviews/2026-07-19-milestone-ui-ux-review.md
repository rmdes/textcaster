# Per-user-feeds milestone (SP1/SP2/SP3) — UI/UX pattern review

Lens: ui-styling skill's accessibility + responsive checklists (principles
only — no Tailwind/shadcn adoption proposed); binding authority:
`design-system/textcaster/MASTER.md` + `web/src/app.css`. Surfaces: home
(tabs + subscribe panel), following page (owner/visitor modes), /admin
(nav + settings). 12 findings: 1 Critical, 5 Important, 4 Minor, 2 Polish.

## Findings

### Critical
1. **Homepage has no `<h1>`.** The masthead is an `<a>`; a page with no
   titled posts ships zero headings — empty heading/landmark list for screen
   readers. Following and admin pages both have real `<h1>`s; home is the
   outlier. Fix: visually-hidden `<h1>` in `main`.

### Important
2. **Subscribe radio groups lack `fieldset`/`legend`** (home + following) —
   no accessible group label for the person/webfeed choice. Fix:
   `<fieldset><legend class="visually-hidden">Subscription type</legend>…`.
3. **Follow/Unfollow buttons ~37px tall** — under the 44px touch-target
   minimum that `.tabs a`/`.admin-nav a` explicitly meet. Fix: `min-height:
   44px` on `.unfollow-form button, .follow-form button` (app.css).
4. **`.admin-nav` never got the focus-visible ring `.tabs` added** — the tab
   bar was modeled on `.admin-nav`, gained the ring, never backported. Two
   identical patterns, two focus treatments. Fix: copy the one rule.
5. **Import result lacks `role="status"` and the `.notice` treatment** —
   sibling "Now following" flash has both. Fix: `class="notice confirm"
   role="status"`.
6. **`.tabs` has no overflow/wrap guard** — four bold 44px labels can exceed
   a 320–375px viewport → horizontal page scroll (MASTER anti-pattern). Fix:
   `overflow-x: auto` on `.tabs`.

### Minor
7. Three "add" forms (subscribe / follow-someone / import) use three
   layouts for one affordance family — align to `.add-remote`'s column flow.
8. Following-list empty state is plain text while the same page's timeline
   empty state is a dashed card — reuse one treatment.
9. Admin settings' number field stretches to 42rem — cap the form at 24rem
   (the `.auth-form` width).
10. The `instance` badge ignores the existing `.badge-kind.on` accent
    variant built for exactly this status-badge case.

### Polish
11. "Core API unreachable — is the core server running?" is operator copy on
    an end-user surface; soften next touch.
12. `.wedge` min-height 32px is also sub-44px — pre-existing shared chrome,
    noted for completeness, not a milestone regression.

## Top-5 fix-pass shortlist
1. Backport the focus-visible ring to `.admin-nav a` (1 CSS rule).
2. `min-height: 44px` on follow/unfollow buttons (1 line).
3. `fieldset`/`legend` around both radio pairs (markup only).
4. `overflow-x: auto` on `.tabs` (1 line).
5. Import result → `role="status"` + `.notice.confirm` (markup only).

Related, already queued in ideas.md: visitor Follow button reuses
`.unfollow-form`'s destructive red (SP3 final review). A single fix pass can
take the top-5 + that restyle together — all token-CSS/markup, no new deps.

---

## Disposition (2026-07-19, commit `c336c7d`)

ALL 12 findings + the queued Follow-button restyle implemented in one
harmonization pass and independently reviewed: per-finding ✅ across the
board, tokens-only, fieldset reset provably scoped (only two fieldsets exist,
both in `.add-remote`), `.wedge` bump verified jank-free (static min-height),
`.admin-nav` focus ring a verbatim copy of `.tabs`', accent-Follow contrast
≈5.2:1 light / ≈5.0:1 dark on surface (AA), old operator copy grep-confirmed
gone from all 4 sites. Gates: web 154/154, svelte-check 0/0. One accepted
judgment call: `.add-remote fieldset` gained flex-column (labels are inline
by default; without it the radios would sit side-by-side).
