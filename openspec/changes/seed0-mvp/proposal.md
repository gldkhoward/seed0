# Proposal: seed0 MVP

## Why

Vercel preview deployments deploy cleanly but are reviewed against trivial or fake
data. Teams approve features in an environment that technically works but does not
behave like production: empty states, high-volume lists, partial states, and
constraint edge cases are never exercised. seed0 makes preview data
production-realistic and **proves it is trustworthy** through deterministic
validation, a tool-checked coverage score, and a user-confirmed plan.

Core thesis: *the model proposes, the tools verify.* The LLM generates scenarios,
predicates, and data; deterministic code is the trust boundary; a fixed rubric
scores whether the output actually covers what was asked.

## What Changes

- New Next.js web app deployed on Vercel.
- AI SDK agent pipeline: parse Postgres schema → plan scenarios (each carrying a
  deterministic predicate) → user confirms plan and reviews pre-run cost
  estimate → generate seed data → validate → repair → evaluate predicates →
  score.
- Canonical dataset output: JSON keyed by table with deterministic value
  serialization and topological row order; Postgres SQL export is derived
  deterministically from that JSON (never produced by the model directly).
- Two distinct bounded retries: the generation step on malformed structured
  output, and the validate/repair loop on constraint violations. No other
  workflow step is automatically retried.
- Durable run orchestration via Vercel Workflows with named steps and a
  content-addressed cache keyed on canonical schema + scenario plan. Run records
  and cached corpora live in Vercel Blob — the single storage substrate.
- Hard caps enforced at submission (maximum schema size, maximum rows, maximum
  wall-clock); the app refuses or truncates with a clear message when caps
  would be exceeded.
- Visual system: shadcn/ui (`new-york`) on Radix + Tailwind v4, Geist Sans
  for interface text and Geist Mono for schema source, predicates, IDs,
  and timestamps, dark mode default. Base palette is `zinc` neutrals with
  a single **green accent** (the "seed" / earth signal) through
  `--color-primary`. This matches Vercel's Geist aesthetic so seed0
  feels native to the audience already inside Vercel, while making
  *instantiated* / *passed* states semantically green for free.
- Fixed 8-table ecommerce demo fixture with 8 named, predicate-bearing
  scenarios, doubling as the Track B evaluation regression check.

## Non-Goals (binding — do not build any of these)

- No auth, accounts, billing, or "purchased" entitlement state.
- No repo write, PR creation, or auto-deploy.
- No connection to real or production databases.
- No load testing or performance benchmarking.
- No sub-agents, parallel agent generation, or multi-agent orchestration. The
  defensible speed story is chunked sequential generation plus the cache.
- No multi-tenant / multi-org modeling.
- Postgres DDL only — no triggers, functions, partitioning, or custom domains.
- No schema-diff-aware incremental regeneration. Any schema change is a cache
  miss and a full regeneration of the affected scope.
- No free-text scenario plan editing. Plan confirmation is show-and-confirm;
  editing is roadmap.
- No secondary storage substrate. Vercel Blob is the only store. Vercel KV is
  sunset (existing stores were migrated to Upstash Redis in December 2024 and
  `@vercel/kv` was deprecated); Marketplace Upstash Redis is not adopted for
  this demo.
- No predictive cost model. The pre-run estimate is deterministic arithmetic
  from posted prices, not a learned predictor.
- No custom design tokens, bespoke component library, or motion system
  beyond shadcn defaults. Surfaces compose only shadcn primitives styled
  through shadcn theme tokens.

## Impact

- New capabilities: `seed-pipeline`, `run-orchestration`, `app-experience`.
- New code: Next.js App Router app, AI SDK integration, Vercel Workflow
  definition, Postgres DDL parser, schema normalizer, canonical dataset
  serializer, structural-shape validator, deterministic constraint validator,
  predicate evaluator, deterministic pre-run cost estimator, hard-cap enforcer,
  Vercel Blob persistence and cache layer.
- Visual system installed via shadcn/ui (`new-york`, Radix base, `zinc`
  neutrals, green `--color-primary`), Geist Sans + Geist Mono via
  `next/font`, dark-mode default.
