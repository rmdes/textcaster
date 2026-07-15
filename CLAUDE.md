# Textcaster — project conventions

## Ponytail workflow

Ponytail mode (lazy/minimal, plugin `ponytail`) is auto-active every session;
the ladder (YAGNI → reuse → stdlib → native → one line → minimum) governs all
code written here. Use the sub-skills systematically:

- `/ponytail-review` — run on the diff after finishing any task that changed
  code, before committing. A Stop hook nudges this automatically when the
  working tree changed since the last review; act on the nudge, don't dismiss it.
- `/ponytail-debt` — run before planning a debt batch; it harvests every
  `ponytail:` shortcut comment into a ledger. Mark every deliberate
  simplification with a `ponytail:` comment so this stays accurate.
- `/ponytail-audit` — whole-repo over-engineering audit; run before large
  refactors or when the codebase feels heavy, not routinely.
- `/ponytail-gain`, `/ponytail-help` — informational, on demand.

Written reports from audit/debt/review runs follow the documentation layout
below: `docs/superpowers/reviews/YYYY-MM-DD-<topic>.md`.

## UI and design system

`design-system/textcaster/MASTER.md` is the source of truth for all UI:
color tokens (light + dark via `light-dark()`), typography (Libre Bodoni /
Public Sans), spacing, component specs, and Textcaster-specific constraints
(no-JS first-class, jank-free live prepends, local/remote legibility, text
first / enclosures second, theme toggle as enhancement only).

- Any task that touches UI — pages, components, styles, layout, colors,
  typography, accessibility — MUST invoke the `ui-ux-pro-max:ui-ux-pro-max`
  skill first, and MUST follow MASTER.md. Page-specific overrides go in
  `design-system/textcaster/pages/<page>.md` and beat MASTER.md.
- No raw hex in components: every color comes from a `--color-*` variable
  defined in `web/src/app.css` (which mirrors MASTER.md). Change palette in
  both places or not at all.

## Documentation layout

All generated markdown lives under `docs/superpowers/`, by kind:

- `specs/` — design documents
- `plans/` — implementation plans
- `reviews/` — code-review findings, improvement suggestions, audits
- `documentation/` — operator/user docs (RUNNING.md, …)

Dated documents are named `YYYY-MM-DD-<topic>.md`. Don't create markdown at
the repo root or directly in `docs/` — `README.md` is the only exception.
Executed plans/specs are historical records: don't rewrite paths inside them
when files move; update live references (README, newer specs) instead.
