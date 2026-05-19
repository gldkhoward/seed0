# Design: seed0 MVP

> **Historical — superseded.** This document describes the originally-planned
> architecture (single-call generator with two retry loops). The shipped
> system is a three-layer composition (deterministic Vercel Workflow +
> architect agent + chunked generator + repair agent). See `README.md` for
> the current design. Kept here for traceability of decisions only.

Locked technical decisions. Each is a defensible interview talking point; the
rationale text is the answer to "why did you do it this way?"

## D1 — Model proposes, tools verify

The LLM is never the trust boundary. Schema parsing, canonical normalization,
constraint validation, predicate evaluation, and scoring are deterministic. The
model only produces *candidate* scenarios, *candidate* predicates, and
*candidate* rows. This is the production-thinking centrepiece and the basis of
the Track B evaluation. D11 is what makes this true at the scoring layer
instead of decorative.

## D2 — Postgres DDL input, scoped parser

Input is a Postgres `CREATE TABLE` script. The parser uses a real SQL AST
library (`pgsql-ast-parser`), not regex. Accepted surface: tables, columns,
types, PRIMARY KEY, FOREIGN KEY, NOT NULL, UNIQUE, CHECK, ENUM/`text` with
check. Explicitly rejected with a clear error: triggers, functions,
partitioning, custom domains. The scoped boundary is a deliberate, stated
decision — not a gap.

## D3 — Content-addressed cache; volume excluded; schema change = full regen

Cache key = `hash(canonical_schema) + hash(scenario_plan)`. Canonical schema
form is defined in D10. Volume is **not** part of the key. Scaling down =
deterministic sampling of the cached corpus with a seeded RNG. Scaling up =
generate only the delta. The model is invoked only when *semantics* change
(schema or scenario plan), never when volume changes.

**Any schema change is a cache miss and triggers full regeneration of the
affected scope.** There is no schema-diff-aware incremental regeneration:
adding columns means every existing row needs values for the new columns —
that is augment-every-row plus schema-diffing plus re-validating
mixed-origin rows, which muddies D3's clean key for negligible build-time
payoff. Incremental regen is a roadmap sentence you say out loud, not code
you write. This is the cost/latency story Track B grades.

## D4 — Vercel Workflows is the durable runtime, not CI

The run executes as a Workflow with named steps. Two bounded retry scopes:
(a) the generation step on malformed structured output, with its own cap;
and (b) the validate/repair loop on constraint failures, with a separate
cap. No other step is automatically retried. Triggering from CI on schema
change is roadmap and is never described as built. The cache hit/miss is
surfaced as an observable run step (visible in the UI).

## D5 — AI Gateway: provider abstraction only for the demo

Gateway is wired as a single provider-abstracted path. Model routing, cost
governance, and fallback are articulated as the enterprise narrative — not
built. Gateway is optional per the brief; we do not over-invest build time
in it.

## D6 — Rendering split is intentional

Landing page and example schema templates are static/cached. The run page,
the plan-confirmation view, and the report are dynamic and streamed because
the user is waiting on generation. The split exists specifically to
demonstrate a defensible rendering trade-off.

## D7 — Demo volume

Default run = ~500 rows total across tables. A single "scale to 2000" action
exercises the delta-generation path only (D3). 2000 is never the default —
it makes the live demo slow for zero added narrative.

## D8 — Decomposed readiness score

Readiness score = (predicate-instantiated scenarios ÷ planned scenarios)
combined with the hard-constraint pass rate. "Instantiated" is defined by
D11: a scenario counts only if at least one canonical row satisfies its
predicate. Every point traces to a named scenario or a specific constraint
check. No opaque or composite "vibe" number is ever shown.

## D9 — Single storage substrate: Vercel Blob

Vercel Blob is the only store. Run records and cached corpora both live in
Blob under stable key prefixes; run history is served by Blob prefix
listing. Vercel KV is sunset — Vercel migrated existing stores to Upstash
Redis in December 2024 and deprecated `@vercel/kv` — so adopting Marketplace
Upstash Redis here would add a second integration and a second failure
surface for zero demo benefit. "One deliberately-chosen store" is itself
the platform-judgment answer; Redis-at-scale is a roadmap sentence.

## D10 — Two normalizations, named separately

Two distinct canonicalizations exist; conflating them is a known foot-gun.

**Schema normalization** (used to compute the cache key): parse DDL → AST →
canonical form:
- lowercase unquoted identifiers,
- strip comments and whitespace,
- canonicalize type aliases (`int4` → `integer`, `varchar` → `character
  varying`, `bool` → `boolean`, and similar),
- sort tables and columns by name within the AST.

Then hash the canonical form. Two logically-identical DDLs produce identical
cache keys.

**Canonical dataset output** (the artifact persisted, returned, and exported
from): a JSON object keyed by table → row arrays, column names from the
schema, deterministic value serialization (ISO-8601 timestamps, decimals as
strings to preserve precision, explicit nulls), tables ordered topologically
for FK-safe insert. The Postgres SQL export is derived deterministically
from this JSON; it is never written by the model.

## D11 — Tool-verifiable scenario instantiation via predicates

Every scenario in the plan carries a **structured predicate**: a small typed
condition expression over rows in named tables (not free text, not raw SQL).
The model proposes the predicate as part of the plan (*model proposes*); the
deterministic predicate evaluator matches the predicate against the
canonical rows (*tools verify*). A scenario counts as instantiated if and
only if at least one canonical row satisfies its predicate. This makes D1
true at the scoring layer instead of decorative — the model can no longer
self-attest to having satisfied a scenario.

The plan, including predicates, is shown to the user for explicit
confirmation before generation runs. This is the verifiable artifact and a
strong demo beat (show-and-confirm), not free-text plan editing — editing
is roadmap.

## D12 — Deterministic pre-run cost estimate + hard caps

A pre-run estimate is shown alongside the plan: planned rows × estimated
tokens per row × model price + a fixed planning cost. The estimate is
arithmetic from posted prices, **not** a predictive model — calling it a
"prediction model" in the interview invites "show me the model"; this is
deliberately deterministic and inspectable.

Hard caps refuse or truncate at submission, with a clear message:
- maximum schema size (input bytes and/or number of tables),
- maximum generated rows per run,
- maximum wall-clock per workflow.

Together these close the denial-of-cost gap that arbitrary user-supplied
DDL would otherwise create.

## D13 — Visual system: Geist + shadcn/ui

The product targets developers reviewing Vercel preview deployments; the
audience is already inside the Vercel UI. Matching the Geist design system
makes seed0 feel native rather than foreign. shadcn/ui (`new-york`) on
Radix primitives with Tailwind v4 is the canonical Vercel-aesthetic stack
and gives us production-grade, accessible components without inventing a
design system. This is also a direct ergonomic win: every UI task in
Section 4 composes from a small, named set of primitives instead of
hand-rolled markup.

Locked:
- **Type** — Geist Sans for interface text, Geist Mono for schema source,
  scenario predicates, run IDs, timestamps, and cost arithmetic. Both via
  `next/font`.
- **Components** — shadcn/ui `new-york` style on Radix; Tailwind v4. No
  bespoke component library.
- **Palette** — base `zinc` for neutrals; a single **green accent**
  through `--color-primary` and `--color-ring`, resonant with the
  "seed" / earth concept. Reference values: `oklch(0.72 0.17 152)` in
  dark mode and `oklch(0.55 0.17 152)` in light mode; both paired with a
  near-black `--color-primary-foreground` for contrast on filled
  surfaces. `--color-destructive` remains the shadcn default (red);
  green is never used for destructive states. Surfaces use only theme
  tokens (`bg-background`, `bg-card`, `text-foreground`,
  `text-muted-foreground`, `border-border`, `ring-ring`,
  `bg-primary`/`text-primary-foreground`). No ad-hoc hex values.

Why green: it directly resonates with "seed" and gives the score's
*instantiated* / *passed* signal its natural color without introducing a
second accent. One brand color carries both meanings.
- **Density** — one comfortable scale per page (`gap-6` / `p-6` /
  `text-sm`).
- **Radius** — shadcn default `--radius: 0.625rem`.
- **Icons** — Lucide at `h-4 w-4` inline, `h-5 w-5` in headers.
- **Mode** — dark mode default (developer tool); light-mode toggle is
  polish.

Component map per surface:

| Surface | Primitives |
|---|---|
| Landing | hero `Card` + example template `Card`s + `Button` |
| Run creation form | `Card` + `Label` + `Textarea` (schema) + `Input` (volume) + `Button` |
| Plan confirmation | scenario `Card`s with predicate `Badge`s + cost-estimate `Card` + `Button` (confirm) + `AlertDialog` (cancel) |
| Progress view | step list (`Card` + step `Badge`s + `Skeleton`) + `Separator` |
| Readiness report | per-scenario `Badge`s + `Progress` / `Card` for pass rate + `Table` for unresolved failures |
| Run history | `Table` + `Badge` + `DropdownMenu` (re-run with new volume) + `Dialog` (volume picker) |

Build-time hazards (named so they don't ambush us):
- `shadcn init` rewrites `globals.css` and can introduce a circular
  `--font-sans: var(--font-sans)` inside `@theme inline`. Tailwind v4
  resolves `@theme inline` at parse time, so `var(--font-geist-sans)`
  also fails there. Use literal `"Geist", "Geist Fallback",
  ui-sans-serif, system-ui, sans-serif` (and the Mono equivalent) in
  `@theme inline`.
- Place Geist `next/font` variable classNames on `<html>`, not `<body>`.

Non-goals (visual scope):
- No custom design tokens beyond what shadcn provides.
- No bespoke component library or in-house primitives.
- No motion system beyond shadcn defaults.
- No multi-theme support beyond dark/light.

## D14: Hard-fail when `BLOB_READ_WRITE_TOKEN` is missing (no in-memory fallback)

The run store throws as soon as any function tries to use Blob if
`BLOB_READ_WRITE_TOKEN` is absent. There is no in-memory fallback path
for dev. Dev and prod exercise exactly the same persistence layer, so
divergence bugs (writes that work locally but fail in deploy) cannot
appear. Onboarding cost is one `vercel link` + one `vercel env pull`,
documented in `.env.example` and README.

The check is lazy (first use), not eager (module load), so `next build`
can analyze server modules without the env var being set in the build
environment.

## D15: Storage layout `runs/{id}/record.json` + `runs/{id}/dataset.json`

Per-run metadata is split from the (potentially large) canonical dataset
so the history view's `list({ prefix: "runs/" })` + parallel fetch of
each `record.json` stays fast. The export route and report view fetch
`dataset.json` separately; the progress page skips that read entirely.
No `runs/index.json` aggregate — it would serialize all writes through
one key and create a cross-run concurrency landmine. Blobs are written
with `access: "private", addRandomSuffix: false, allowOverwrite: true,
cacheControlMaxAge: 0` so pathnames are stable, the store is not
publicly browsable (run records contain user-supplied schemas and
product context), and reads are not CDN-cached. The signed URLs
returned by `put`/`list` remain fetchable from server code, which is
the only consumer.

## D16: Flush record.json on every state transition

Each `setRunStep` / `setRunStatus` / `setRunPlan` / `setRunReport` /
`markRun*` call performs a read-mutate-write against `record.json`
(~9-10 PUTs per run). The alternative — batching per step or writing
only on terminal status — defeats the live progress view, which the
spec requires. PUT cost at demo scale is trivial; correctness and
crash-visibility win. Within a single run, steps execute sequentially
so there is no intra-run write race; across runs, keys are
namespaced by `runId`.

## D17: Seed demo history on first read against an empty prefix

`listRuns()` and `getRun()` call `ensureSeededHistory()`, which on the
first invocation `list`s the `runs/` prefix; if empty, it writes three
predetermined demo runs (with fixed timestamps, not relative ones) so
the history view is never empty on a freshly-provisioned Blob store.
Subsequent invocations short-circuit on the in-process promise. After
any real run lands, the prefix is non-empty and seeding is permanently
skipped. Re-seeding only happens if all blobs are deleted.
