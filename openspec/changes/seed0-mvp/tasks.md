# Tasks: seed0 MVP

Sequenced for a 4–6h build. Items above the cut line are the defensible MVP.
Items below are high narrative value but sacrificed first if time runs short.

Status reconciled against code on 2026-05-18. Sections 1, 2, 3, 4, 5, and the
non-deploy parts of 7 are done. §6 (cache) is the only above-cut-line work
deliberately deferred; the deploy smoke test in 7.3 happens once the project
is linked to Vercel.

## 1. Setup

- [x] 1.1 Next.js App Router project scaffolded (Next 16.2.6, React 19.2.4,
      Tailwind v4, TS); `vercel link` + initial deploy deferred to 7.3
- [x] 1.2 Added `ai@6` + `zod@4`; `lib/ai.ts` exposes a Zod-typed
      `structuredOutput` helper wrapping `generateObject`
- [x] 1.3 Added `pgsql-ast-parser@12`; `lib/sql.ts` wraps `parse`; full
      demo-schema parse exercised in 2.1/5.1
- [x] 1.4 Added `@vercel/blob@2`; `lib/blob.ts` re-exports
      `put/list/head/del`; live write/read/list deferred until
      `BLOB_READ_WRITE_TOKEN` is set
- [x] 1.5 `shadcn@latest init -d` (new-york, Radix, zinc neutrals);
      moved fonts to a non-inline `@theme` block to avoid the parse-time
      gotcha; `--primary` / `--ring` set to green
      (`oklch(0.55 0.17 152)` light, `oklch(0.72 0.17 152)` dark) with
      near-black `--primary-foreground` in dark mode (D13)
- [x] 1.6 Installed `geist@1.7`; `app/layout.tsx` applies
      `GeistSans.variable` + `GeistMono.variable` to `<html>` and sets
      `dark` class for dark-mode default (D13)
- [x] 1.7 Added baseline shadcn components: button, card, input,
      textarea, label, badge, table, dialog, alert-dialog, dropdown-menu,
      skeleton, separator, progress (D13)

## 2. Pipeline core (the spine — must work end to end)

- [x] 2.1 Schema parser: DDL → entity model (accepted subset only) (D2)
      — `lib/parser.ts`
- [x] 2.2 Reject + clearly error on unsupported constructs (D2)
      — `UnsupportedConstructError` + `SchemaParseError` in `lib/parser.ts`
- [x] 2.3 Scenario planner (AI, structured output) — emits scenarios each
      carrying a structured predicate (D11), bound to parsed entities
      — `lib/planner.ts` (`generatePlan` + `bindPlan`)
- [x] 2.4 Seed generator (AI, structured output) bound to plan + entities
      — `lib/generator.ts`
- [x] 2.5 Structural shape validator: rejects malformed model output before
      constraint validation; feeds the generation-step retry (D4)
      — `lib/shape-validate.ts`
- [x] 2.6 Deterministic constraint validator: required, FK, enum, check,
      unique, type — `lib/validate.ts`
- [x] 2.7 Repair loop: failed records + errors → regenerate, capped retries
      — `runRepairLoop` in `lib/generator.ts` + `stepValidateAndRepair` in
      `workflows/run.ts` (cap 3)
- [x] 2.8 Bounded retry of the generation step on malformed structured output
      (distinct from the repair loop, separate cap) (D4)
      — `callWithShapeRetry` in `lib/generator.ts` + `stepGenerate` in
      `workflows/run.ts` (cap 2)
- [x] 2.9 Canonical dataset output (D10): JSON keyed by table, deterministic
      value serialization, topological table order — `lib/canonical.ts`
- [x] 2.10 Predicate evaluator: matches scenario predicates against canonical
       rows; emits per-scenario instantiated/missing status (D11)
       — `lib/predicate-eval.ts`
- [x] 2.11 Decomposed readiness score: predicate-instantiated scenarios +
       hard-constraint pass rate (D8) — `lib/score.ts`

## 3. Orchestration

- [x] 3.1 Wrap the run as a Vercel Workflow with named steps (parse, plan,
      confirm, generate, validate, repair, predicate-evaluate, score, persist)
      — `workflows/run.ts` (`runWorkflow` + the nine step functions; confirm is
      a `createHook<{ confirmed: boolean }>` pause)
- [x] 3.2 Scope retries: generation-step retry (2.8) and validate/repair retry
      (2.7) — no other automatic retries — all step functions in
      `workflows/run.ts` carry `maxRetries = 0` except `stepPlan` (AI SDK
      default of 2); the two caps live inside `stepGenerate` and
      `stepValidateAndRepair`
- [x] 3.3 Persist run record + canonical dataset to Vercel Blob (D9, D14, D15, D16)
      — `lib/run-store.ts` (`runs/{id}/record.json` + `runs/{id}/dataset.json`,
      flushed on every state transition). Hard-fails on first use if
      `BLOB_READ_WRITE_TOKEN` is missing; no in-memory fallback.
- [x] 3.4 Run history listing via Blob prefix (D17) — `listRuns()` in
      `lib/run-store.ts` does `list({ prefix: "runs/" })` + parallel fetch of
      each `record.json`. Seeds three demo runs on first read against an
      empty prefix so a fresh Blob store doesn't show an empty history.

## 4. App experience

- [x] 4.1 Run creation form (schema, context, volume) with inline validation
      — `app/new/page.tsx` + `components/run-form.tsx`
- [x] 4.2 Hard-cap enforcement at submission (max schema size, max rows, max
      wall-clock) — refuse or truncate with a clear message (D12)
      — `HARD_CAPS` + checks in `submitRunAction` (`lib/ui-actions.ts`):
      schema bytes/table count refuse; row count truncates with notice.
      Wall-clock cap is not enforced at submission (no place for it — runtime
      cap belongs in workflow config; track separately if needed).
- [x] 4.3 Plan confirmation view: shows the plan, each scenario's predicate,
      and the deterministic pre-run cost estimate; user confirms or cancels
      before generation runs (D11, D12)
      — `app/runs/[id]/confirm/page.tsx` + `components/plan-confirm.tsx`
      (uses `estimateRunCost`); confirm/cancel call `confirmRunAction` /
      `cancelRunAction` which resume the workflow hook.
- [x] 4.4 Run progress view (stream/poll step status, including cache step
      when in scope) — `app/runs/[id]/page.tsx` + `components/run-progress.tsx`;
      cache step is rendered as `pending` since §6 is unbuilt.
- [x] 4.5 Readiness report view (per-scenario predicate result, constraint
      pass rate, unresolved failures) — `app/runs/[id]/report/page.tsx` +
      `components/readiness-report.tsx`
- [x] 4.6 Export: canonical JSON + Postgres seed SQL derived deterministically
      from the JSON, dependency-ordered — `lib/canonical-export.ts`
      (`canonicalJson` + `canonicalSql`) served via
      `app/runs/[id]/export/[format]/route.ts`
- [~] 4.7 Run history view; "re-run with new volume" action exercises cache
      scale-down/up — history view (`app/runs/page.tsx`, now Blob-backed) and
      `rerunWithVolumeAction` exist, but "exercises cache scale-down/up" is
      hollow until §6 lands (re-run currently just starts a fresh full run).

## 5. Demo fixture + evaluation

- [x] 5.1 8-table ecommerce schema + product context as an example template
      — `lib/fixtures/ecommerce.ts` (`ECOMMERCE_DDL`, `ECOMMERCE_CONTEXT`)
- [x] 5.2 Fixed 8-scenario plan with predicates for the fixture
      — `ECOMMERCE_PLAN` in `lib/fixtures/ecommerce.ts`
- [x] 5.3 Evaluation regression: fixture → assert constraint pass +
      predicate-based coverage threshold; fail loudly otherwise
      — `scripts/run-eval.ts` wired to `pnpm eval`; uses `createPipeline` +
      `assertRegression(ECOMMERCE_FIXTURE)` and exits non-zero on threshold
      miss. Track B requirement satisfied.

--- CUT LINE — everything above is the defensible MVP ---

## 6. Efficiency narrative (high value, first to cut)

- [ ] 6.1 Schema normalization (D10): AST → canonical form, used to compute
      the cache key
- [ ] 6.2 Content-addressed cache keyed on canonical schema + scenario plan,
      stored in Vercel Blob (D3, D9)
- [ ] 6.3 Scale down = deterministic sample of cached corpus (seeded RNG)
- [ ] 6.4 Scale up = generate delta only, append, preserve cached records
- [ ] 6.5 Cache hit/miss surfaced as a visible run step
- [ ] 6.6 One-click "scale to 2000" exercising the delta path

## 7. Polish (last)

- [x] 7.1 Static landing + cached example templates (rendering split)
      — `app/page.tsx` is `export const dynamic = "force-static"` and lists
      the ecommerce template.
- [x] 7.2 AI Gateway as the single provider-abstracted path
      — `lib/ai.ts` calls AI SDK `generateObject` with plain
      `"provider/model"` strings; `workflows/run.ts` uses
      `"anthropic/claude-sonnet-4-6"` via `AI_GATEWAY_API_KEY`.
- [~] 7.3 Deploy smoke test + README with the architecture narrative
      — README rewritten with stack, scripts, deploy steps, and architecture
      narrative. `vercel link` + first deploy still pending; smoke test is
      "load /, start a run, see it complete, check Blob shows
      `runs/{id}/record.json` + `dataset.json`".

## Notes

- If time is short, cut Section 6 before Section 5. The evaluation (5.3) is a
  Track B requirement and is never sacrificed.
- Section 6 is the cost/latency story. If it survives, it is the strongest
  efficiency talking point — protect 6.1–6.5 over 6.6.
- AI Gateway (7.2) is optional per the brief; do not let it consume spine
  time.
- D11 (predicates) is load-bearing: without it, D1 is decorative and the
  score is meaningless. Tasks 2.3, 2.10, 4.3, and 5.2 are non-negotiable.
- Hard caps (4.2) belong above the cut line because they close the
  denial-of-cost gap that arbitrary user-supplied DDL would otherwise
  create.
- Vercel Blob (1.4, 3.3, 3.4) is the only persistence substrate; do not
  add Upstash Redis or any second store.
- D13 (Geist + shadcn) is locked. UI tasks in Section 4 compose only
  shadcn primitives per the component map; avoid raw `<div>` / `<button>`
  / `<input>` markup where a primitive exists.
