# Spec review — walkable feeds / threadwalker parity (2026-07-17, 22edad6)

Grounded in reads of the spec, Dave's `walker.js`, the current `feed.ts`
emission, `sqlite.ts` ref resolution, and a live probe of feedsmith 2.9.6.
guid=permalink is a **settled direction** (approved in the parallel session,
and it makes good on the pre-existing "threadwalker-walkable" claim the
threading milestone's money test only ever validated against docs, never
against Dave's code). So this review checks groundedness and coordination, not
whether to switch.

**Verdict: sound and well-grounded — ready to plan after the firehose
reconciliation (F-1).** The design is minimal and correct; the one load-bearing
serialization pin is now verified (not deferred); the real work is reconciling
this against the in-flight firehose spec, which currently decides the opposite.

## The central premise is verified against Dave's actual code

`walker.js:92` — `if (item.guid === guidStartingPost)` where
`guidStartingPost` is a URL string — a plain `===` compare after xml2js parses
with `explicitArray: false`. Any attribute on `<guid>` makes xml2js yield an
object (`{_, $}`), so the compare silently never matches. So the emitted guid
must be (a) the permalink URL and (b) **attribute-free**. The spec's premise and
its "run 1 printed nothing" diagnosis are exactly right.

## F-2 — VERIFIED (was "probe at plan time"): the omit-the-key fallback is mandatory

Probed feedsmith 2.9.6 directly:

| input to feedsmith | emitted | walker-safe? |
|---|---|---|
| `{ value: url, isPermaLink: true }` | `<guid isPermaLink="true">url</guid>` | **NO** — attribute breaks the compare |
| `{ value: url }` (key omitted) | `<guid>url</guid>` | **YES** — bare |
| `{ value: uuid, isPermaLink: false }` | `<guid isPermaLink="false">uuid</guid>` | n/a (today's form) |
| `'url'` (bare string) | *no guid element at all* | N/A — feedsmith needs the object form |

So the self-review's pin is not just prudent, it's **required**: feedsmith emits
`isPermaLink="true"` as an explicit attribute, which breaks the walker exactly
as `false` does. **Pin for the plan:** `localGuid`'s URL branch must translate to
`{ value: url }` with the `isPermaLink` key **omitted** at the feedsmith call —
not `{ value, isPermaLink: true }`. The spec's `localGuid` returns
`{ value, isPermaLink: boolean }`; the renderer must drop the key for the
`true` case (and never pass a bare string). The walker-parity test asserting the
emitted shape is what guards this permanently.

## F-1 — HIGH (coordination): this reverses the firehose spec's guid decision #1, which is in-flight

The firehose spec (`2e44bf6`, decision #1) keeps UUID guid + `isPermaLink="false"`
with the permalink in `<link>`, and its money test asserts guid stability
("never changes shape"). This spec changes the emitted guid to the bare
permalink URL. They **contradict on the emitted guid**, and the firehose is being
implemented in the parallel tab right now against the old decision
(uncommitted `feed.ts`/`feed.test.ts`). Required reconciliation:

- **Retract/annotate firehose decision #1** so the two committed specs don't
  contradict on the record. (Its stated rationale — "don't change guid values" —
  was a stability argument that only bites with real federated peers; pre-release
  there are none, and the live walker evidence overturns it. This also revises my
  own firehose review, which endorsed keeping UUID guids as "required" — that was
  right only under the peers-exist assumption.)
- **Update the firehose guid-stability test** — it asserts the old
  UUID+`isPermaLink="false"` shape and will break when the guid becomes a bare
  permalink. This is real test work, not a merge conflict.
- **Sequence so the permalink guid lands once** — not UUID-first then switched
  mid-build, which would fire the "one-time identity break" during development
  for no reason. The spec's "Interaction with in-flight work" section frames
  `feed.ts` as a shared-file *merge* concern; it undersells it — the substance is
  a contradictory *decision* to reconcile, not just careful staging.

## Correctness — verified sound

- **Injector guid-keying is handled.** `injectSourceComments` /
  `injectSourceAccounts` match on the `<guid>` element value in the XML; the
  call sites today pass `p.guid` (UUID). The spec correctly requires them to pass
  the **emitted** guid (the permalink) instead (lines 75-77) — without that,
  injection wouldn't match the new bare-URL guid. Good catch; enumerated.
- **Reply-ref resolution still works.** Replies carry the parent's *emitted*
  guid = permalink URL; `replyWireElements` already emits URL refs attribute-free
  (`feed.ts:36-42`, the `isUrl` branch), and `findPostByRef` (`sqlite.ts:223`)
  resolves a permalink ref via its `url` arm and/or `guid` arm. Threading holds.
- **Storage-untouched / emission-only** is clean — no migration, UUID kept as
  internal fallback, remote pass-through unchanged. The one-time break is
  consciously accepted (pre-release, delete-and-refollow); self-ingest stays
  coherent because guid == link == the same permalink.

## F-3 — MED (pin): guid/link coherence if publicUrl ever changes

`localGuid` reconstructs `${publicUrl}/post/${id}` from the **current** publicUrl
at emission, but the firehose milestone (decision #2) stores `url` from the
**creation-time** publicUrl. If publicUrl ever changes, an old post's emitted
guid (current) would diverge from its `<link>` (stored `url`) — un-Dave-like,
since his guid == permalink == link. **Pin:** derive guid, `<link>`, and
reply-refs for a given post from **one** permalink source at emission so they
can't drift — or consciously accept the divergence given publicUrl is stable
pre-release. Cheapest coherent form: reuse the stored `p.url` when present.

## F-4 — note (dependency): source:account injector

The per-user/comments `source:account` injection reuses the firehose's
`injectSourceAccounts` (built by the parallel session). This spec depends on that
existing — fine if the firehose lands first, but it's an ordering dependency, not
independent work. Confirm `service`/`name` scheme matches the firehose's
(`service` = publicUrl host, `name` = handle) — the spec says it does.

## Ponytail
Minimal and correct: one `localGuid` derivation function, emission-only, no
storage or migration, injectors gain a sibling not a rewrite. The walker-parity
test is a justified interop pin, not gold-plating. Nothing to cut.

## What to change before planning
Reconcile with the in-flight firehose spec (F-1: retract decision #1, update its
guid-stability test, sequence the guid change once). Fold the verified feedsmith
pin (F-2) into the plan as "omit the isPermaLink key." Pin guid/link/ref
coherence (F-3). Note the `injectSourceAccounts` dependency (F-4). The premise,
the emission-only design, reply resolution, and the money test are all sound.
