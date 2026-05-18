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

```
Postgres DDL                AI SDK (planner)            User confirms plan
   │                              │                            │
   ▼                              ▼                            ▼
Parse ─► EntityModel ─► Plan ─► Predicates ─► Cost estimate ─► (hook)
                                                                 │
                                                                 ▼
                AI SDK (generator) ─► Shape validator ─► Constraint validator
                                                                 │
                                       ┌─────────────────────────┴─┐
                                       │ failures? bounded repair  │
                                       └─────────────────────────┬─┘
                                                                 ▼
                                                 Canonical dataset (D10)
                                                                 │
                          Predicate evaluator ◄──────────────────┤
                                       │                         │
                                       ▼                         ▼
                              Readiness score          Persist to Blob
```

The whole run is a [Vercel Workflow](https://vercel.com/docs/workflow) with
named steps so failures resume at the right place. Two — and only two — loops
are automatically retried: the generation step on malformed structured output,
and the validate/repair loop on constraint violations. Both caps are explicit.

## Stack

- **Framework**: Next.js 16 App Router, React 19, TypeScript, Tailwind v4
- **UI**: shadcn/ui (new-york, Radix base, zinc neutrals, green primary), Geist Sans + Mono
- **AI**: AI SDK v6 via Vercel AI Gateway (`provider/model` strings, no per-provider SDKs)
- **Orchestration**: Vercel Workflow with named steps and a human-confirm hook
- **Persistence**: Vercel Blob (single store; `runs/{id}/record.json` + `dataset.json`)
- **Schema parsing**: `pgsql-ast-parser` for an AST-driven Postgres DDL subset

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
| `pnpm eval`        | Run the demo regression against the live AI Gateway. Asserts 100% constraint pass and 100% predicate coverage on the 8-table ecommerce fixture; exits non-zero otherwise. Track B requirement. |

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
components/             View-only React (shadcn primitives only; no raw <div>/<button>)
lib/
  ai.ts                 AI SDK wrapper (structuredOutput via generateObject)
  parser.ts             DDL → EntityModel; rejects unsupported constructs
  planner.ts            Scenario planner; predicates bound to entity model
  generator.ts          Seed generator with shape-retry + repair-retry caps
  shape-validate.ts     Structural shape validator (gates generation-step retry)
  validate.ts           Constraint validator (FK, enum, check, unique, type)
  canonical.ts          Canonical dataset assembly (deterministic, topological)
  canonical-export.ts   JSON + Postgres-SQL export derived from canonical form
  predicate-eval.ts     Deterministic predicate evaluator (D11)
  score.ts              Decomposed readiness score (predicate + constraint)
  pipeline.ts           Assembles modules behind the Pipeline interface
  run-store.ts          Vercel Blob-backed run record + dataset persistence
  ui-actions.ts         Server actions (submit, confirm, cancel, re-run)
  ui-types.ts           View-model types + HARD_CAPS + cost estimate
  fixtures/             Ecommerce demo fixture (DDL, context, plan)
  eval/regression.ts    Track B regression check (used by `pnpm eval`)
workflows/run.ts        Vercel Workflow definition with named steps
scripts/run-eval.ts     CLI entrypoint for `pnpm eval`
openspec/               Spec, design decisions, and task checklist
```

## Constraints (binding)

- No auth, accounts, billing, or real DB connections.
- Postgres DDL only — no triggers, functions, partitioning, custom domains.
- Vercel Blob is the only persistence substrate; no second store.
- No predictive cost model — the pre-run estimate is deterministic arithmetic.
- No free-text plan editing — plan confirmation is show-and-confirm.
- Surfaces compose only shadcn primitives — no bespoke design system.
