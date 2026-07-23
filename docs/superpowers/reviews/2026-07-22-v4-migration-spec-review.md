# V4 spec review — migration & cutover (2026-07-22)

Target: `docs/superpowers/specs/2026-07-22-rsc-migration-cutover-design.md`
(rev 0, ec9c45d, 696 lines — loop-authored). Dual pass: ponytail (WP1–WP5) +
correctness (WC1–WC3), adjudicated. **Verdict: citation-exact and
contract-faithful (every push-in.ts/schema/route line verified; V1 ops route
reproduced verbatim; V2 activation extension explicitly sanctioned) — fold
rev 1 for one cross-vertical lockstep fix, one guard hardening, and five
ponytail cuts. All five of rev 0's flagged decisions are UPHELD by both
reviewers (one-big-transaction; startup-error flip-back; lease-lapse;
inert legacy rows; legacy_unknown widening).**

## Cross-vertical (fold touches V3 too)

### WC1 — The CHECK-pin closure cites V3's precedent INVERTED; V3 §1.2 must be re-amended in lockstep

V4 §10 closure #1 says "V3 §1.2 already proved enum-narrower-than-CHECK is
the workable pattern" — but V3 §1.2 (rev 1) says the OPPOSITE for
`source_audit_v2`: TS enum and CHECK kept EQUAL at six, "nothing ever
widens," open item 2 marked resolved. If the verticals ship per V3's text,
conversion's `category='migration_review'` INSERT (§3.1) hits the six-value
CHECK and aborts the entire pre-listen transaction — forcing the rebuild the
pin was meant to avoid. **Fix (both docs, same commit):** V4 §10 restates the
closure without the false precedent (the directive stands on its own: SQL
CHECKs pin the full foundation vocabulary, TS enums stay narrowed per
vertical); V3 §1.2 gains a dated lockstep note (source_audit_v2's CHECK pins
all nine per V4 §10; the TS enum stays six) and V3's open item 2 is reopened
as "resolved via V4 §10 pin — V1 plan fold must implement the wide CHECK."

## Correctness

### WC2 — "Ends with renewDue()" misdescribes v1's poll tail (line 53)

v1's cycle ends with `purgeExpiredSubscriptions` (push-in.ts:272), not
renewDue (:271). The spec cites :272 correctly elsewhere; fix the sentence so
the v1 baseline it claims to preserve is stated accurately.

### WC3 — The conversion guard's redundant clause hides a silent-skip corruption path (§4.1 step 2)

"Never activated AND no conversion recorded": under normal operation
active-implies-converted (atomic step 3), so the first clause is redundant —
but an anomalous DB (hand-repaired/partially-restored metadata) with
state='active' and no conversion marker would silently SKIP conversion, and
§4.3's marker-keyed guard never engages: the dual-model state the roadmap
forbids. **Fix:** make the anomaly fail loudly — if activation shows active
but the conversion marker is absent, fail startup with a named error
(mirrors the existing `database is newer than this build` pattern), never
skip. One condition becomes a tripwire instead of a hole.

## Ponytail cuts (WP1–WP5)

- **WP1 — Runtime push lifecycle collapses to v1's shape:** keep two runtime
  states + delete-on-denial + purge-expired (push-in.ts:200-202, :272); the
  poll pass re-registers from the latest run's claim anyway. Migration-time
  `expired`/`invalid` facts become REPORT findings (§3.6), not live
  re-attemptable rows. Kills the 4×4 transition matrix, half the push
  acceptance suite, and the admin state/expiry rendering. (`SourceSummary.
  push.state` narrows accordingly — note the V1-plan DTO consequence.)
- **WP2 — Report as log lines + marker counts:** no findings relation, no
  cursor-paginated `/admin/migration/report`; governance-bearing rows
  (migration_review) already surface via the existing quarantine navigation.
  `ponytail: add the queryable report if paging is ever requested`.
- **WP3 — Off-flag regression: gate assertions, not a byte-identical suite:**
  assert the flag routes to the legacy path and no V4 module loads when off;
  the existing legacy tests are the behavioral coverage. (The suite would
  have lived one release before §7 deletes it.)
- **WP4 — No speculative run-claim table:** bind the push-capability claim to
  V2's acquisition-run rows (one nullable column/blob) at V2 plan time; drop
  §9's reserved entry.
- **WP5 — Drop the bespoke post-purge reservation branch:** reservation
  blocks registration (keep — charter guard); the redirect 404s naturally
  via the ordinary not-found path once the publisher is gone.

## Upheld decisions (record — do not re-litigate at plan time)

#1 one-transaction conversion (SQLite single-writer, single-user volume;
chunking buys nothing). #2 startup-error flip-back reusing the
`database is newer` fail-loud pattern (sqlite.ts:696-697) as the entire
flip-back surface. #3 lease-lapse/no-unsubscribe (inherited V3). #4 inert
legacy rows with `posts` pinned as local-content authority + post-soak
cleanup batch. #5 `legacy_unknown` provenance widening (lossy mapping would
let a legacy timestamp masquerade as an authoritative watermark).

## Verified clean (highlights)

Every cited line exact across push-in.ts (:16-26, :30-39, :41-46, :48-50,
:79-83, :149-164, :200-202, :208-210, :218-221, :231-234, :238-241, :264,
:271-272), schema DDL (posts :576-587, subscriptions :592-604,
push_subscriptions :607-620 — no CHECK on state, migrated rows legal;
follows :623-628; post_revisions :667-675; feed_type :682-688), the
newer-than-build guard (:696-697), types.ts:84, app.ts :63/:65/:407/:415,
auth.ts :64-66, config.ts :44-45/:60-62, push.ts :49. V2 §5.6 capability
shape and §7.1 activation-transaction extension faithful (V2 explicitly
reserves final migration for V4); marker-guard/user_version coexistence
sound (crash between migration and marker retries idempotently). V1 ops
route reproduced verbatim (plan L797-806) incl. actor ID derivation and
fingerprint. Pause/block matrix matches V3 §3 point-for-point. The CHECK
escalation's factual basis confirmed (foundation nine vs V1-review six).

## Handoff

Fold as V4 rev 1 + the V3 §1.2/open-item-2 lockstep amendment in one commit.
After this fold, all four verticals have dual-reviewed specs; remaining
READY work is plans — V1 fold and V2 plan land with the other tab, then V3/V4
plans follow the roadmap's sequential order.

---

# PLAN REVIEW (2026-07-23): V4 plan draft dual pass → V4 rev 2 + V2 rev 6 instructions

Ponytail (PT1-5) + correctness (FC1-5), adjudicated. All five risky calls
UPHELD (two-column marker with the inline dev-reset note; no-FK reservations
+ repo-layer guard as root-cause placement; push CASCADE self-justified;
202-discard; token-only ops route — trim the over-strong spec citation).

**FC1 (adjudicated — DROP amendment 1, take the additive path):** the
2-value reason CHECK and NOT NULL run_id facts are true, but push provenance
needs no enum widening: V4's own tail migration adds a nullable
`delivery_mechanism` column on acquisition_runs_v2 ('push' when a ping
created the run); thin pings reuse the existing one-shot reason per spec
§1.4's own wording; `push_ping` was plan-invented — delete it. V2 stays
untouched on this point and the refuse-execution coupling for it goes away.
**FC2 (V4 fold — the real completeness gap):** Task 6 defines the synthetic
observation-evidence contract explicitly: canonical_material /
raw_evidence_json / normalized_json are BUILT from the converted post's
fields, wrapped in a marked synthetic envelope (e.g. {"synthetic":
"migration", ...}); state why integrity holds — reconciliation reads
normalized_json (which IS the correct converted content) and verification
fetches live publisher URLs (never re-reads stored evidence as authenticity
proof); migration observations carry run_id='migration' (no FK engaged —
verified) and wire_ordinal/seen counts get defined synthetic values.
**FC3+PT1 (V4 fold + V2 rev 6):** amendment 3 reframed as a NON-BLOCKING
shape pin (the defensive parser makes any shape forward-safe) — removed from
the refuse-execution prerequisite set; its tail dedup per PT1 (defensive
parse lives in Task 2 only; stale pointer lives in Task 12 only).
**FC4 (V2 rev 6):** fix BOTH stale "validated by Vertical 3" pointers (V2
Appendix A L574 AND Step 1b L340) → Vertical 4; add the shape comment beside
the column while editing.
**FC5 (V4 fold):** fix the url placeholder to match spec §6's binding block
byte-for-byte (or drop the word "verbatim").
**PT2 (V4 fold):** Task 10 Step 2 asserts composition only (seed → one
pre-listen transaction → flip → SSR projects); field-level correctness stays
in Tasks 5-8.
**PT3 (V4 fold):** Appendix D keeps only the byte-exact push loop + the two
tripwire matchers; the pause/lease/ops snippets go (task prose is
unambiguous).
**PT4 (V4 fold):** Appendix B table deleted; the fault-injection line moves
to Task 8.

V2 rev 6 = amendment 2 ONLY (presentation provenance CHECK gains
legacy_unknown — verified genuinely un-widenable post-creation, no additive
path, wire-widening already anticipated at V2 L451) + the two FC4 pointer
fixes + the shape comment. Nothing else.

Verified clean: all four callback routes + single injected pushInApi seam;
ops-401-before-403; V1 fingerprint adopted verbatim; pending_review real;
byte-exact push column map; synthetic run_id engages no FK; tripwires
mutually exclusive and directionally exhaustive; TESTING/RUNNING commands
exact; Task 12 gates landings not content.
