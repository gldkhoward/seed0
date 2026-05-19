/**
 * seed0 generation run as a durable Vercel Workflow.
 *
 * Steps map to the spec's run-orchestration capability: parse, plan,
 * confirm (pause for human approval), generate (with bounded
 * shape-retry), validate-and-repair (bounded retry loop on constraint
 * failures), predicate-evaluate, score, persist.
 *
 * D4 retry policy: only the generation and validate/repair loops are
 * automatically retried; everything else has maxRetries=0 because the
 * deterministic steps are pure functions and retrying is wasted work.
 *
 * D11 verification: scenario instantiation is judged by evaluating the
 * structured predicates against canonical rows in `stepPredicateEvaluate`.
 * The model never self-attests.
 */

import {
  createHook,
  FatalError,
  getWorkflowMetadata,
} from "workflow";

import { parseSchema, UnsupportedConstructError, SchemaParseError } from "@/lib/parser";
import {
  ArchitectPlanError,
  buildFallbackPlan,
  runArchitectAgent,
  synthesizeDeterministicPlan,
} from "@/lib/architect-agent";
import { chunkedGenerate } from "@/lib/chunked-generator";
import { runCoverageBoost } from "@/lib/coverage-boost";
import { runRepairAgent, type ToolCallTrace } from "@/lib/repair-agent";
import { publishAgentThought } from "@/lib/run-stream";
import {
  buildCacheEntry,
  getCachedDataset,
  hashEntityModel,
  putCachedDataset,
} from "@/lib/run-cache";
import { validateShape, StructuralShapeError } from "@/lib/shape-validate";
import { validateDataset } from "@/lib/validate";
import { toCanonical } from "@/lib/canonical";
import { evaluatePlan } from "@/lib/predicate-eval";
import { buildReadinessReport } from "@/lib/score";
import {
  ensureRunRecord,
  markRunCancelled,
  markRunFailed,
  setRunCacheHit,
  setRunDataset,
  setRunExecutionPlan,
  setRunPlan,
  setRunReport,
  setRunSchemaHash,
  setRunStatus,
  setRunStep,
} from "@/lib/run-store";
import type {
  ArchitectPlan,
  CanonicalDataset,
  EntityModel,
  ExecutionPlan,
  ReadinessReport,
  ScenarioEvaluation,
  ScenarioPlan,
  ValidationReport,
} from "@/lib/types";

/**
 * Planning needs scenario reasoning; repair needs to interpret failure
 * messages and produce structurally-correct replacements. Both stay on
 * Sonnet. Generation is heavily constrained — pre-allocated PKs, FK
 * value pools, Zod-typed columns — so it's a slot-filling task, and
 * Haiku 4.5 hits it 3–4× faster at indistinguishable structural quality.
 */
export const RUN_LLM_MODEL = "anthropic/claude-sonnet-4-6";
export const GEN_LLM_MODEL = "anthropic/claude-haiku-4-5";
/**
 * Minimum acceptable generated rows as a fraction of the requested
 * volume. With chunked generation (lib/chunked-generator.ts) hitting
 * this guard usually means one or more per-table calls failed
 * silently rather than the whole single-shot call returning `{}`.
 */
const MIN_GENERATION_FRACTION = 0.3;

export interface RunWorkflowInput {
  schema: string;
  context: string;
  volume: number;
}

// ---- Step functions ----

async function stepInit(runId: string, input: RunWorkflowInput) {
  "use step";
  await ensureRunRecord(runId, {
    schemaSource: input.schema,
    productContext: input.context,
    requestedVolume: input.volume,
  });
  await setRunStatus(runId, "pending_plan");
}
stepInit.maxRetries = 0;

async function stepParse(runId: string, ddl: string): Promise<EntityModel> {
  "use step";
  await setRunStep(runId, "parse", "running");
  try {
    const model = parseSchema(ddl);
    if (model.tables.length === 0) {
      throw new SchemaParseError(
        "Schema parsed to 0 tables — at least one CREATE TABLE statement is required.",
      );
    }
    const tables = model.tables.map((t) => ({
      name: t.name,
      columns: t.columns.length,
      foreignKeys: t.columns.filter((c) => c.references).length,
      uniques:
        t.columns.filter((c) => c.unique || c.primaryKey).length +
        (t.uniqueConstraints?.length ?? 0),
      enums: t.columns.filter((c) => c.enumValues && c.enumValues.length > 0).length,
      checks:
        t.columns.filter((c) => c.check).length + (t.checks?.length ?? 0),
    }));
    await setRunStep(
      runId,
      "parse",
      "succeeded",
      `${tables.length} table${tables.length === 1 ? "" : "s"} parsed`,
      { tables },
    );
    return model;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setRunStep(runId, "parse", "failed", msg, { error: msg });
    await markRunFailed(runId, `parse: ${msg}`);
    if (
      e instanceof UnsupportedConstructError ||
      e instanceof SchemaParseError
    ) {
      throw new FatalError(msg);
    }
    throw new FatalError(msg);
  }
}
stepParse.maxRetries = 0;

async function stepHashSchema(
  runId: string,
  entityModel: EntityModel,
): Promise<string> {
  "use step";
  const hash = hashEntityModel(entityModel);
  await setRunSchemaHash(runId, hash);
  return hash;
}
stepHashSchema.maxRetries = 0;

/**
 * The architect agent designs scenarios AND the execution plan
 * (parallelism, allocations, optional steps, cache reuse). When the
 * agent fails to produce a valid plan we fall back to the legacy
 * scenarios-only planner plus a deterministic execution plan.
 */
async function stepArchitect(
  runId: string,
  entityModel: EntityModel,
  productContext: string,
  volume: number,
  schemaHash: string,
): Promise<ArchitectPlan> {
  "use step";
  await setRunStep(runId, "plan", "running");
  try {
    const result = await runArchitectAgent({
      entityModel,
      productContext,
      llmModel: RUN_LLM_MODEL,
      schemaHash,
      volume,
    });
    if (result.plan.scenarios.length === 0) {
      throw new Error(
        "Architect returned 0 scenarios — cannot proceed without anything to verify.",
      );
    }
    await persistArchitectPlan(runId, result.plan, result.toolCalls.length);
    return result.plan;
  } catch (e) {
    if (e instanceof ArchitectPlanError) {
      // Architect's plan was invalid — fall back to legacy planner +
      // deterministic execution plan rather than failing the run.
      await setRunStep(
        runId,
        "plan",
        "running",
        `architect rejected (${e.issues.length} issue${e.issues.length === 1 ? "" : "s"}) — falling back`,
      );
      try {
        const fallback = await buildFallbackPlan({
          entityModel,
          productContext,
          llmModel: RUN_LLM_MODEL,
          volume,
        });
        await persistArchitectPlan(runId, fallback, 0, {
          fallback: true,
          architectIssues: e.issues,
        });
        return fallback;
      } catch (fallbackErr) {
        const msg =
          fallbackErr instanceof Error
            ? fallbackErr.message
            : String(fallbackErr);
        await setRunStep(runId, "plan", "failed", msg, { error: msg });
        await markRunFailed(runId, `plan: ${msg}`);
        throw new FatalError(msg);
      }
    }
    const msg = e instanceof Error ? e.message : String(e);
    await setRunStep(runId, "plan", "failed", msg, { error: msg });
    await markRunFailed(runId, `plan: ${msg}`);
    throw new FatalError(msg);
  }
}
stepArchitect.maxRetries = 2;

async function persistArchitectPlan(
  runId: string,
  plan: ArchitectPlan,
  toolCallCount: number,
  extra?: Record<string, unknown>,
): Promise<void> {
  const scenarioPlan: ScenarioPlan = { scenarios: plan.scenarios };
  await setRunPlan(runId, scenarioPlan);
  await setRunExecutionPlan(runId, plan.execution);
  await setRunStep(
    runId,
    "plan",
    "succeeded",
    `${plan.scenarios.length} scenario${plan.scenarios.length === 1 ? "" : "s"} · ${plan.execution.parallelGroups.length} wave(s) · cache=${plan.execution.cacheDecision.kind}`,
    {
      scenarioCount: plan.scenarios.length,
      scenarios: plan.scenarios.map((s) => ({
        id: s.id,
        name: s.name,
        table: s.predicate.table,
      })),
      executionPlan: plan.execution,
      toolCallCount,
      reasoning: plan.execution.reasoning,
      ...(extra ?? {}),
    },
  );
}

/**
 * Honor the architect's cache decision. When `reuse`, load the cached
 * dataset and short-circuit generation. When `regenerate`, mark the
 * step succeeded with the reason and let generation proceed.
 */
async function stepCache(
  runId: string,
  execution: ExecutionPlan,
  schemaHash: string,
): Promise<Record<string, Record<string, unknown>[]> | undefined> {
  "use step";
  await setRunStep(runId, "cache", "running");
  if (execution.cacheDecision.kind === "regenerate") {
    await setRunCacheHit(runId, false);
    await setRunStep(
      runId,
      "cache",
      "succeeded",
      "regenerating · agent chose fresh data",
      {
        decision: "regenerate",
        reason: execution.cacheDecision.reason,
      },
    );
    return undefined;
  }
  const entry = await getCachedDataset(
    schemaHash,
    execution.cacheDecision.sourceRunId,
  );
  if (!entry) {
    // Race: cache was visible to the architect but gone now. Fail
    // open by regenerating rather than failing the run.
    await setRunCacheHit(runId, false);
    await setRunStep(
      runId,
      "cache",
      "succeeded",
      "cache miss · entry disappeared, regenerating",
      {
        decision: "regenerate",
        reason: "Cached entry disappeared between architect inspection and load.",
        sourceRunId: execution.cacheDecision.sourceRunId,
      },
    );
    return undefined;
  }
  // Rehydrate raw dataset (the cache stores canonical; we want the
  // raw record-array shape the rest of the pipeline expects).
  const rawDataset: Record<string, Record<string, unknown>[]> = {};
  for (const [t, rows] of Object.entries(entry.dataset.tables)) {
    rawDataset[t] = rows.map((r) => ({ ...r }));
  }
  await setRunCacheHit(runId, true);
  await setRunStep(
    runId,
    "cache",
    "succeeded",
    `cache hit · reusing ${entry.totalRows} rows from ${entry.sourceRunId.slice(0, 8)}`,
    {
      decision: "reuse",
      sourceRunId: entry.sourceRunId,
      reason: execution.cacheDecision.reason,
      sourceCreatedAt: entry.createdAt,
      totalRows: entry.totalRows,
      tableRowCounts: entry.tableRowCounts,
    },
  );
  return rawDataset;
}
stepCache.maxRetries = 1;

async function stepMarkGenerateSkipped(runId: string) {
  "use step";
  await setRunStep(
    runId,
    "generate",
    "skipped",
    "skipped · cache reused",
  );
}
stepMarkGenerateSkipped.maxRetries = 0;

async function stepMarkConfirmRunning(runId: string) {
  "use step";
  await setRunStep(runId, "confirm", "running");
  await setRunStatus(runId, "awaiting_confirmation");
}
stepMarkConfirmRunning.maxRetries = 0;

async function stepMarkConfirmed(runId: string) {
  "use step";
  await setRunStep(runId, "confirm", "succeeded");
  await setRunStatus(runId, "running");
}
stepMarkConfirmed.maxRetries = 0;

async function stepHandleCancellation(runId: string) {
  "use step";
  await setRunStep(runId, "confirm", "skipped");
  await markRunCancelled(runId, "User cancelled at plan confirmation");
}
stepHandleCancellation.maxRetries = 0;

async function stepGenerate(
  runId: string,
  entityModel: EntityModel,
  plan: ScenarioPlan,
  execution: ExecutionPlan,
  productContext: string,
  volume: number,
): Promise<Record<string, Record<string, unknown>[]>> {
  "use step";
  await setRunStep(runId, "generate", "running");
  const minRows = Math.max(1, Math.floor(volume * MIN_GENERATION_FRACTION));

  const tableProgress: Record<string, number> = {};
  let allocations: Record<string, number> = {};
  let autoAllocatedKeys: Record<string, string> = {};
  let tableCount = entityModel.tables.length;

  try {
    const result = await chunkedGenerate({
      entityModel,
      plan,
      volume,
      productContext,
      llmModel: GEN_LLM_MODEL,
      externalAllocations: execution.tableAllocations,
      externalParallelGroups: execution.parallelGroups,
      onProgress: async (event) => {
        if (event.kind === "start") {
          allocations = event.allocations;
          autoAllocatedKeys = event.autoAllocatedKeys;
          tableCount = event.tableCount;
          await setRunStep(
            runId,
            "generate",
            "running",
            `${tableCount} table(s) in parallel`,
            {
              chunked: true,
              allocations,
              autoAllocatedKeys,
              tableProgress: {},
              requestedVolume: volume,
            },
          );
          return;
        }
        if (event.kind === "table-complete") {
          tableProgress[event.table] = event.rowCount;
          const done = Object.keys(tableProgress).length;
          const totalSoFar = Object.values(tableProgress).reduce(
            (a, b) => a + b,
            0,
          );
          await setRunStep(
            runId,
            "generate",
            "running",
            `${done}/${tableCount} tables · ${totalSoFar} rows so far`,
            {
              chunked: true,
              allocations,
              autoAllocatedKeys,
              tableProgress: { ...tableProgress },
              requestedVolume: volume,
            },
          );
        }
      },
    });

    const validated = validateShape(result.rows, entityModel);
    const totalRows = Object.values(validated).reduce(
      (sum, rows) => sum + rows.length,
      0,
    );

    if (totalRows < minRows) {
      throw new StructuralShapeError([
        {
          path: "<dataset>",
          message: `chunked generation produced ${totalRows} rows; expected at least ${minRows} toward the target of ${volume}. One or more per-table calls likely failed silently.`,
        },
      ]);
    }

    const rowsByTable = Object.fromEntries(
      Object.entries(validated).map(([t, rows]) => [t, rows.length]),
    );
    const sampleTable = Object.entries(validated).sort(
      (a, b) => b[1].length - a[1].length,
    )[0];

    await setRunStep(
      runId,
      "generate",
      "succeeded",
      `${totalRows} row${totalRows === 1 ? "" : "s"} across ${Object.keys(rowsByTable).filter((t) => rowsByTable[t] > 0).length} table(s) · parallel`,
      {
        chunked: true,
        totalRows,
        requestedVolume: volume,
        allocations,
        autoAllocatedKeys,
        tableProgress,
        rowsByTable,
        sampleRow:
          sampleTable && sampleTable[1].length > 0
            ? { table: sampleTable[0], row: sampleTable[1][0] }
            : null,
      },
    );
    return validated;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setRunStep(runId, "generate", "failed", msg, {
      chunked: true,
      error: msg,
      allocations,
      tableProgress,
    });
    await markRunFailed(runId, `generate: ${msg}`);
    throw new FatalError(msg);
  }
}
stepGenerate.maxRetries = 0;

async function stepValidateAndRepair(
  runId: string,
  entityModel: EntityModel,
  plan: ScenarioPlan,
  rawDataset: Record<string, Record<string, unknown>[]>,
  productContext: string,
): Promise<{ canonicalDataset: CanonicalDataset; validation: ValidationReport }> {
  "use step";
  await setRunStep(runId, "validate", "running");
  let canonical = toCanonical(rawDataset, entityModel);
  let validation = validateDataset(canonical, entityModel);
  const initialFailureCount = validation.failures.length;

  // Tell the UI we observed the failures before the agent does anything.
  const initialByConstraint: Record<string, number> = {};
  const initialByTable: Record<string, number> = {};
  for (const f of validation.failures) {
    initialByConstraint[f.constraint] =
      (initialByConstraint[f.constraint] ?? 0) + 1;
    initialByTable[f.table] = (initialByTable[f.table] ?? 0) + 1;
  }
  await setRunStep(
    runId,
    "validate",
    "succeeded",
    `${validation.passingRecords}/${validation.totalRecords} passing`,
    {
      totalRecords: validation.totalRecords,
      passingRecords: validation.passingRecords,
      passRate: validation.passRate,
      failureCount: validation.failures.length,
      failuresByConstraint: initialByConstraint,
      failuresByTable: initialByTable,
      sampleFailures: validation.failures.slice(0, 5).map((f) => ({
        table: f.table,
        rowIndex: f.rowIndex,
        column: f.column ?? null,
        constraint: f.constraint,
        detail: f.detail,
      })),
    },
  );

  if (initialFailureCount === 0) {
    await setRunStep(runId, "repair", "succeeded", "no failures to repair", {
      initialFailures: 0,
      finalFailures: 0,
      toolCalls: [] as ToolCallTrace[],
    });
    return { canonicalDataset: canonical, validation };
  }

  await setRunStep(
    runId,
    "repair",
    "running",
    `agent starting · ${initialFailureCount} failure(s)`,
    {
      initialFailures: initialFailureCount,
      toolCalls: [] as ToolCallTrace[],
    },
  );

  const toolCalls: ToolCallTrace[] = [];

  const agent = await runRepairAgent({
    initialDataset: rawDataset,
    initialFailures: validation.failures,
    entityModel,
    plan,
    productContext,
    llmModel: RUN_LLM_MODEL,
    stepCap: 24,
    onToolCall: async (event) => {
      toolCalls.push(event);
      // Push an incremental snapshot so the UI can stream the trace.
      // We re-write the full toolCalls array since setRunStep merges
      // details shallowly — a deep array merge would be brittle.
      await setRunStep(
        runId,
        "repair",
        "running",
        `agent · ${event.name}${event.ok ? "" : " (failed)"} · ${toolCalls.length} call(s)`,
        {
          initialFailures: initialFailureCount,
          toolCalls: [...toolCalls],
        },
      );
      // Also mirror to the namespaced agent-thoughts stream so the
      // narration panel sees architect + repair on one channel.
      await publishAgentThought({
        agent: "repair",
        at: event.at,
        kind: "tool-call",
        toolName: event.name,
        message: `${event.name}${event.ok ? "" : " (failed)"} · total failures now ${
          (event.result?.totalFailures as number | undefined) ?? "?"
        }`,
        data: event.result,
      });
    },
  });

  canonical = toCanonical(agent.dataset, entityModel);
  validation = agent.validation;
  const finalFailures = validation.failures.length;

  const stoppedReason = agent.stoppedReason;
  const cleared = initialFailureCount - finalFailures;

  await setRunStep(
    runId,
    "repair",
    finalFailures === 0 ? "succeeded" : "failed",
    finalFailures === 0
      ? `agent cleared ${cleared} failure(s) in ${agent.toolCalls.length} tool call(s)`
      : `${finalFailures} unresolved after ${agent.toolCalls.length} tool call(s) — stopped: ${stoppedReason}`,
    {
      initialFailures: initialFailureCount,
      finalFailures,
      cleared,
      toolCalls: [...toolCalls],
      stoppedReason,
      ...(agent.errorMessage ? { error: agent.errorMessage } : {}),
    },
  );

  return { canonicalDataset: canonical, validation };
}
stepValidateAndRepair.maxRetries = 0;

async function stepPredicateEvaluate(
  runId: string,
  plan: ScenarioPlan,
  canonicalDataset: CanonicalDataset,
): Promise<readonly ScenarioEvaluation[]> {
  "use step";
  await setRunStep(runId, "predicate-evaluate", "running");
  const evaluations = evaluatePlan(plan, canonicalDataset);
  const instantiated = evaluations.filter((e) => e.instantiated).length;
  const missingScenarios = evaluations
    .filter((e) => !e.instantiated)
    .map((e) => e.scenarioId);
  await setRunStep(
    runId,
    "predicate-evaluate",
    "succeeded",
    `${instantiated}/${plan.scenarios.length} scenarios instantiated`,
    {
      total: plan.scenarios.length,
      instantiated,
      missingScenarios,
      results: evaluations.map((e) => ({
        scenarioId: e.scenarioId,
        instantiated: e.instantiated,
        matchedRowCount: e.matchedRowCount,
      })),
    },
  );
  return evaluations;
}
stepPredicateEvaluate.maxRetries = 0;

/**
 * Optional coverage-boost step. Runs only when the architect enabled
 * it AND there are uninstantiated scenarios. Regenerates rows for the
 * tables that anchor missing scenarios, then re-evaluates predicates
 * on the merged dataset. Replaces the canonical + evaluations with
 * the post-boost versions.
 */
async function stepCoverageBoost(
  runId: string,
  entityModel: EntityModel,
  plan: ScenarioPlan,
  execution: ExecutionPlan,
  rawDataset: Record<string, Record<string, unknown>[]>,
  evaluations: readonly ScenarioEvaluation[],
  productContext: string,
): Promise<{
  canonicalDataset: CanonicalDataset;
  validation: ValidationReport;
  evaluations: readonly ScenarioEvaluation[];
  ran: boolean;
}> {
  "use step";
  const missing = evaluations
    .filter((e) => !e.instantiated)
    .map((e) => e.scenarioId);
  const enabled = execution.optionalSteps.includes("coverage-boost");
  if (!enabled || missing.length === 0) {
    // Compute current canonical / validation so callers always get a
    // fully-typed result, even when boost is skipped.
    const canonical = toCanonical(rawDataset, entityModel);
    const validation = validateDataset(canonical, entityModel);
    await setRunStep(
      runId,
      "coverage-boost",
      "skipped",
      enabled
        ? "no missing scenarios — boost unnecessary"
        : "architect did not enable coverage-boost",
      {
        enabled,
        missingScenarios: missing,
      },
    );
    return { canonicalDataset: canonical, validation, evaluations, ran: false };
  }
  await setRunStep(
    runId,
    "coverage-boost",
    "running",
    `boosting ${missing.length} missing scenario(s)`,
    { enabled: true, missingScenarios: missing },
  );
  const boost = await runCoverageBoost({
    entityModel,
    plan,
    productContext,
    llmModel: RUN_LLM_MODEL,
    dataset: rawDataset,
    missingScenarioIds: missing,
  });
  const canonical = toCanonical(rawDataset, entityModel);
  const validation = validateDataset(canonical, entityModel);
  const reEvaluations = evaluatePlan(plan, canonical);
  const instantiatedAfter = reEvaluations.filter((e) => e.instantiated).length;
  await setRunStep(
    runId,
    "coverage-boost",
    "succeeded",
    `added ${boost.totalAddedRows} row(s) across ${boost.perTable.length} table(s)`,
    {
      enabled: true,
      missingScenariosBefore: missing,
      perTable: boost.perTable,
      totalAddedRows: boost.totalAddedRows,
      instantiatedAfter,
      totalScenarios: plan.scenarios.length,
    },
  );
  return {
    canonicalDataset: canonical,
    validation,
    evaluations: reEvaluations,
    ran: true,
  };
}
stepCoverageBoost.maxRetries = 0;

async function stepScore(
  runId: string,
  plan: ScenarioPlan,
  validation: ValidationReport,
  evaluations: readonly ScenarioEvaluation[],
) {
  "use step";
  await setRunStep(runId, "score", "running");
  const report = buildReadinessReport({ plan, validation, evaluations });
  await setRunReport(runId, report);
  await setRunStep(
    runId,
    "score",
    "succeeded",
    `coverage ${(report.predicateCoverage * 100).toFixed(0)}% · constraints ${(report.constraintPassRate * 100).toFixed(0)}%`,
    {
      constraintPassRate: report.constraintPassRate,
      predicateCoverage: report.predicateCoverage,
    },
  );
  return report;
}
stepScore.maxRetries = 0;

/**
 * The final status depends on what actually shipped, not on whether the
 * workflow walked all its steps. We want "succeeded" reserved for runs
 * that fully cleared constraints AND instantiated every scenario.
 * Anything weaker is "partial" — the export still works, but the demo
 * shouldn't claim a clean win.
 */
function decideFinalStatus(report: ReadinessReport): "succeeded" | "partial" {
  const allConstraints = report.constraintPassRate >= 1;
  const allScenarios = report.predicateCoverage >= 1;
  return allConstraints && allScenarios ? "succeeded" : "partial";
}

async function stepPersist(
  runId: string,
  canonicalDataset: CanonicalDataset,
  report: ReadinessReport,
  cacheArgs?: {
    schemaHash: string;
    productContext: string;
    requestedVolume: number;
    plan: ScenarioPlan;
  },
) {
  "use step";
  await setRunStep(runId, "persist", "running");
  await setRunDataset(runId, canonicalDataset);
  const finalStatus = decideFinalStatus(report);
  const totalRows = Object.values(canonicalDataset.tables).reduce(
    (sum, rows) => sum + rows.length,
    0,
  );

  // Cache the canonical dataset so future runs with the same schema
  // shape can short-circuit generation. We only cache fully-successful
  // runs — partials may have constraint violations we shouldn't reuse.
  let cached = false;
  if (cacheArgs && finalStatus === "succeeded") {
    try {
      await putCachedDataset(
        buildCacheEntry({
          schemaHash: cacheArgs.schemaHash,
          sourceRunId: runId,
          productContext: cacheArgs.productContext,
          requestedVolume: cacheArgs.requestedVolume,
          plan: cacheArgs.plan,
          dataset: canonicalDataset,
        }),
      );
      cached = true;
    } catch {
      // Cache write is best-effort; don't fail the run.
    }
  }

  // Mark the persist step succeeded BEFORE flipping run.status to a
  // terminal value. The streaming client tears down on terminal status
  // — if status flipped first, the client would abort before seeing the
  // step transition and Persist would render stuck on "running".
  await setRunStep(
    runId,
    "persist",
    "succeeded",
    `persisted · status ${finalStatus}${cached ? " · cached" : ""}`,
    {
      totalRows,
      tableCount: canonicalDataset.tableOrder.length,
      finalStatus,
      cached,
    },
  );
  await setRunStatus(runId, finalStatus);
}
stepPersist.maxRetries = 0;

// ---- Workflow ----

export async function runWorkflow(input: RunWorkflowInput) {
  "use workflow";

  const meta = getWorkflowMetadata();
  const runId = meta.workflowRunId;

  await stepInit(runId, input);
  const entityModel = await stepParse(runId, input.schema);
  const schemaHash = await stepHashSchema(runId, entityModel);
  const architectPlan = await stepArchitect(
    runId,
    entityModel,
    input.context,
    input.volume,
    schemaHash,
  );
  const scenarioPlan: ScenarioPlan = { scenarios: architectPlan.scenarios };

  await stepMarkConfirmRunning(runId);
  const hook = createHook<{ confirmed: boolean }>({
    token: `confirm-${runId}`,
  });
  const decision = await hook;

  if (!decision.confirmed) {
    await stepHandleCancellation(runId);
    return { runId, status: "cancelled" as const };
  }

  await stepMarkConfirmed(runId);

  // Cache decision is the architect's. When `reuse`, we get a raw
  // dataset back and skip generation entirely. When `regenerate`, we
  // generate fresh.
  const cachedRaw = await stepCache(runId, architectPlan.execution, schemaHash);
  const rawDataset = cachedRaw
    ? (await stepMarkGenerateSkipped(runId), cachedRaw)
    : await stepGenerate(
        runId,
        entityModel,
        scenarioPlan,
        architectPlan.execution,
        input.context,
        input.volume,
      );
  const { canonicalDataset: initialCanonical, validation: initialValidation } =
    await stepValidateAndRepair(
      runId,
      entityModel,
      scenarioPlan,
      rawDataset,
      input.context,
    );
  const initialEvaluations = await stepPredicateEvaluate(
    runId,
    scenarioPlan,
    initialCanonical,
  );

  // Optional coverage-boost — runs only if the architect enabled it
  // AND scenarios are missing.
  const boost = await stepCoverageBoost(
    runId,
    entityModel,
    scenarioPlan,
    architectPlan.execution,
    rawDataset,
    initialEvaluations,
    input.context,
  );
  const canonicalDataset = boost.canonicalDataset;
  const validation = boost.validation;
  const evaluations = boost.evaluations;
  const report = await stepScore(runId, scenarioPlan, validation, evaluations);
  await stepPersist(runId, canonicalDataset, report, {
    schemaHash,
    productContext: input.context,
    requestedVolume: input.volume,
    plan: scenarioPlan,
  });

  return {
    runId,
    status: decideFinalStatus(report),
  };
}
