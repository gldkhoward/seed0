# seed0

Production-realistic seed data for preview deployments — provably trustworthy.

Vercel preview deployments build cleanly but are reviewed against trivial data.
Empty states, high-volume lists, partial states, and constraint edge cases never
get exercised. seed0 makes preview data look like production *and proves it*
through deterministic predicates and a tool-checked readiness score.

**Core thesis: the model proposes, the tools verify.** The LLM generates
scenarios, predicates, and rows. Deterministic code parses, validates, evaluates
predicates, and scores. The model is never the trust boundary.

## How it works

**Three-layer composition.** A deterministic [Vercel Workflow](https://vercel.com/docs/workflow)
orchestrates the run end-to-end — step order, fan-out, validation, scoring, and
persistence are procedural code. Two scoped LLM tool-call loops sit inside
named steps: an **architect** that designs the execution plan and decides cache
reuse (hard cap: 8 tool-call steps), and a **repair agent** that fixes
constraint violations the deterministic validator surfaced (hard cap: 20
tool-call steps). Each tool either reads state or mutates and re-validates
immediately, so the agents cannot declare success — they can only propose, and
the deterministic validator decides. Generation, schema parsing, predicate
evaluation, scoring, and persistence are pure deterministic code. The agents
do not delegate to each other and have no nested planning; both are invoked
exactly once per run.

### Pipeline

parse → schema-hash → architect (plan + cache-decision) → confirm-pause
(human-in-the-loop) → optional cache-rehydrate → chunked parallel generate
→ deterministic validate → repair agent → predicate-evaluate → optional
coverage-boost → score → persist.

`predicate-evaluate` (`lib/predicate-eval.ts`) is the deterministic
verification point: a scenario counts as covered only when at least one
generated row mechanically satisfies its predicate — the model never scores
its own coverage. The cache decision and coverage-boost are both observable
workflow steps.

Step-level automatic retry is deliberately conservative: only the architect
(max 2) and the cache read (max 1) retry. Generation and repair don't,
because each has its own bounded internal loop — sub-chunk halve-on-parse-
fail in the chunked generator, the tool-call step cap in the repair agent —
that streams progress to the UI incrementally instead.

### Evaluation

`pnpm eval` runs the regression by default against the 8-table ecommerce
fixture and asserts ≥100% constraint pass and ≥100% predicate coverage,
exiting non-zero otherwise. It exercises the shipping generation path —
the same `chunkedGenerate` + `repair-agent` the workflow uses — with a
deterministic execution plan from `synthesizeDeterministicPlan` so the
eval measures generation + repair quality without mixing in architect
planning variance. The architect's contribution is exercised by every
live demo run and visible in the agent-thoughts stream.

`pnpm eval -- --fixture <slug>` runs a single template; `pnpm eval -- --all`
runs every entry in `TEMPLATES` (8 fixtures, 62 hand-authored predicates
total) and is the matrix gate for flipping a template's `available: true`
in `app/page.tsx` — clicking through to an un-eval'd surface should be
structurally impossible.

## Stack

- **Framework**: Next.js 16 App Router, React 19, TypeScript, Tailwind v4
- **UI**: shadcn/ui (new-york, Radix base, zinc neutrals, green primary), Geist Sans + Mono
- **AI**: AI SDK v6 (`ai@^6`) via Vercel AI Gateway — one key, no provider SDK.
  Two-stage model split: Sonnet (`anthropic/claude-sonnet-4-6`) for judgment
  (architect, repair); Haiku (`anthropic/claude-haiku-4-5`) for bulk slot-
  filling in the chunked generator. The expensive model only does judgment.
- **Orchestration**: Vercel Workflow with named steps and a human-confirm
  hook. Long-running and streaming workloads run on Vercel Fluid Compute (the
  platform default), which keeps the events-stream connection open for the
  duration of a run.
- **Streaming**: the workflow's NDJSON stream is piped straight to the browser
  via `app/runs/[id]/events/route.ts`, resumable with `?startIndex=N`. A
  namespaced `agent:thoughts` stream carries live tool-call narration. No
  client polling.
- **Persistence**: Vercel Blob (single store; `runs/{id}/record.json` +
  `runs/{id}/dataset.json`; content-addressed dataset cache under
  `cache/<schemaHash>/<runId>.json`).
- **Schema parsing**: `pgsql-ast-parser` for an AST-driven Postgres DDL subset.

## Local setup

```bash
pnpm install
vercel link                      # link to a Vercel project with Blob enabled
vercel env pull .env.local       # pulls AI_GATEWAY_API_KEY + BLOB_READ_WRITE_TOKEN
pnpm dev
```

The app **hard-fails at startup** if `BLOB_READ_WRITE_TOKEN` is missing — dev
and prod use the same persistence path, by design, so there are no two code
paths to keep in sync.

On the first read against an empty `runs/` prefix, three seeded demo runs are
written to Blob so the history view is never empty for a fresh deployment.

## Scripts

| Command            | What it does                                                |
| ------------------ | ----------------------------------------------------------- |
| `pnpm dev`         | Next dev server                                             |
| `pnpm build`       | Production build                                            |
| `pnpm start`       | Run the built app                                           |
| `pnpm lint`        | ESLint (Next config)                                        |
| `pnpm typecheck`   | `tsc --noEmit`                                              |
| `pnpm eval`        | Run the demo regression against the live AI Gateway. Defaults to the 8-table ecommerce fixture; `-- --all` runs every template (8 fixtures, 62 predicates). Asserts 100% constraint pass and 100% predicate coverage; exits non-zero otherwise. Track B requirement. |

## Deploying

```bash
vercel              # preview
vercel --prod       # production
```

Both `AI_GATEWAY_API_KEY` and `BLOB_READ_WRITE_TOKEN` must be set on the
project's environment variables. With Blob enabled on the project and the AI
Gateway provisioned in the team, both are populated automatically — no manual
secrets.

## Where things live

```
app/                    Next App Router routes
  page.tsx              Landing (force-static)
  new/                  Run creation form
  runs/                 History + per-run views (progress, confirm, report, export)
components/             View-only React (shadcn primitives only)
workflows/run.ts        Vercel Workflow definition with named steps
scripts/run-eval.ts     CLI entrypoint for `pnpm eval`
lib/
  # AI / generation (the LLM-touching code)
  ai.ts                 AI SDK wrapper (generateObject for structured output)
  architect-agent.ts    Plan + cache-decision LLM tool-call loop (cap 8 steps)
  chunked-generator.ts  Parallel, FK-aware generator (pre-allocated PKs + uniques)
  repair-agent.ts       Repair LLM tool-call loop (cap ~20; re-validates per tool)
  repair-deterministic.ts  Pure-code repair strategies the agent dispatches to
  coverage-boost.ts     Optional regeneration for uninstantiated scenarios
  generator.ts          Legacy single-call generator — unreferenced; kept for history
  planner.ts            Legacy scenarios-only planner — architect fallback path

  # Deterministic core (LLM-free)
  parser.ts             DDL → EntityModel; rejects unsupported constructs
  shape-validate.ts     Structural shape validator
  validate.ts           Constraint validator (FK, enum, check, unique, type)
  canonical.ts          Canonical dataset assembly (deterministic, topological)
  canonical-export.ts   JSON + Postgres-SQL export derived from canonical form
  predicate-eval.ts     Deterministic predicate evaluator — the verification point
  score.ts              Decomposed readiness score (predicate + constraint)
  pipeline.ts           Legacy Pipeline factory — superseded by eval/workflow-pipeline.ts

  # Plumbing
  run-store.ts          Vercel Blob-backed run record + dataset persistence
  run-cache.ts          Content-addressed dataset cache (Vercel Blob)
  run-stream.ts         Live progress + agent-thoughts stream publishers
  ui-actions.ts         Server actions (submit, confirm, cancel, re-run)
  ui-types.ts           View-model types + HARD_CAPS + cost estimate
  fixtures/             Ecommerce fixture (eval'd) + 7 example schemas
  eval/regression.ts    Track B regression check (used by `pnpm eval`)
  eval/workflow-pipeline.ts  Wires chunkedGenerate + repair-agent into the Pipeline (shipping path)
openspec/               Historical spec — superseded; kept for traceability
```

## Constraints (binding)

- No auth, accounts, billing, or real DB connections.
- Postgres DDL only — no triggers, functions, partitioning, custom domains.
- Vercel Blob is the only persistence substrate; no second store.
- No predictive cost model — the pre-run estimate is deterministic arithmetic.
- No free-text plan editing — plan confirmation is show-and-confirm.
- Surfaces compose only shadcn primitives — no bespoke design system.
