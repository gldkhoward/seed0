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
import { generatePlan } from "@/lib/planner";
import { generateRepair } from "@/lib/generator";
import { chunkedGenerate } from "@/lib/chunked-generator";
import { validateShape, StructuralShapeError } from "@/lib/shape-validate";
import { validateDataset } from "@/lib/validate";
import { toCanonical } from "@/lib/canonical";
import { evaluatePlan } from "@/lib/predicate-eval";
import { buildReadinessReport } from "@/lib/score";
import {
  ensureRunRecord,
  markRunCancelled,
  markRunFailed,
  setRunDataset,
  setRunPlan,
  setRunReport,
  setRunStatus,
  setRunStep,
} from "@/lib/run-store";
import type {
  CanonicalDataset,
  EntityModel,
  ReadinessReport,
  ScenarioEvaluation,
  ScenarioPlan,
  ValidationReport,
} from "@/lib/types";

export const RUN_LLM_MODEL = "anthropic/claude-sonnet-4-6";
const REPAIR_RETRY_CAP = 3;
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

async function stepPlan(
  runId: string,
  entityModel: EntityModel,
  productContext: string,
): Promise<ScenarioPlan> {
  "use step";
  await setRunStep(runId, "plan", "running");
  try {
    const plan = await generatePlan({
      model: entityModel,
      productContext,
      llmModel: RUN_LLM_MODEL,
    });
    if (plan.scenarios.length === 0) {
      throw new Error("Planner returned 0 scenarios — cannot proceed without anything to verify.");
    }
    await setRunPlan(runId, plan);
    await setRunStep(
      runId,
      "plan",
      "succeeded",
      `${plan.scenarios.length} scenario${plan.scenarios.length === 1 ? "" : "s"}`,
      {
        scenarioCount: plan.scenarios.length,
        scenarios: plan.scenarios.map((s) => ({
          id: s.id,
          name: s.name,
          table: s.predicate.table,
        })),
      },
    );
    return plan;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setRunStep(runId, "plan", "failed", msg, { error: msg });
    await markRunFailed(runId, `plan: ${msg}`);
    throw new FatalError(msg);
  }
}
// Plan is a single LLM call; let the AI SDK retry transient failures
// (network blips, model 5xx) up to the WDK default. Don't add a higher
// cap here — repeated planner failures usually indicate a structural
// problem (model can't honor the schema).
stepPlan.maxRetries = 2;

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
  productContext: string,
  volume: number,
): Promise<Record<string, Record<string, unknown>[]>> {
  "use step";
  await setRunStep(runId, "generate", "running");
  const minRows = Math.max(1, Math.floor(volume * MIN_GENERATION_FRACTION));

  const tableProgress: Record<string, number> = {};
  let allocations: Record<string, number> = {};
  let stages: readonly (readonly string[])[] = [];
  let autoAllocatedKeys: Record<string, string> = {};

  try {
    const result = await chunkedGenerate({
      entityModel,
      plan,
      volume,
      productContext,
      llmModel: RUN_LLM_MODEL,
      onProgress: async (event) => {
        if (event.kind === "start") {
          allocations = event.allocations;
          stages = event.stages;
          autoAllocatedKeys = event.autoAllocatedKeys;
          await setRunStep(
            runId,
            "generate",
            "running",
            `chunked across ${entityModel.tables.length} table(s) in ${stages.length} FK stage(s)`,
            {
              chunked: true,
              allocations,
              stages: stages.map((s) => [...s]),
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
            `stage ${event.stage + 1}/${stages.length} · ${done}/${entityModel.tables.length} tables · ${totalSoFar} rows so far`,
            {
              chunked: true,
              allocations,
              stages: stages.map((s) => [...s]),
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
      `${totalRows} row${totalRows === 1 ? "" : "s"} across ${Object.keys(rowsByTable).filter((t) => rowsByTable[t] > 0).length} table(s) · chunked`,
      {
        chunked: true,
        totalRows,
        requestedVolume: volume,
        allocations,
        stages: stages.map((s) => [...s]),
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
      stages: stages.map((s) => [...s]),
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
  volume: number,
): Promise<{ canonicalDataset: CanonicalDataset; validation: ValidationReport }> {
  "use step";
  await setRunStep(runId, "validate", "running");
  let current = rawDataset;
  let canonical = toCanonical(current, entityModel);
  let validation = validateDataset(canonical, entityModel);
  let attempt = 0;

  while (validation.failures.length > 0 && attempt < REPAIR_RETRY_CAP) {
    await setRunStep(
      runId,
      "repair",
      "running",
      `repair attempt ${attempt + 1}/${REPAIR_RETRY_CAP} · ${validation.failures.length} failure(s)`,
    );
    const failures = validation.failures.map((f) => ({
      table: f.table,
      index: f.rowIndex,
      reason: `${f.constraint}: ${f.detail}`,
      row: current[f.table]?.[f.rowIndex],
    }));
    const replacements = await generateRepair({
      model: entityModel,
      plan,
      volume,
      productContext,
      llmModel: RUN_LLM_MODEL,
      failures,
    });

    const indicesByTable: Record<string, number[]> = {};
    for (const f of validation.failures) {
      const k = f.table;
      if (!indicesByTable[k]) indicesByTable[k] = [];
      if (!indicesByTable[k].includes(f.rowIndex)) indicesByTable[k].push(f.rowIndex);
    }

    const next: typeof current = {};
    for (const [tbl, rows] of Object.entries(current)) {
      next[tbl] = rows.map((r) => ({ ...r }));
    }
    for (const [tbl, replRows] of Object.entries(replacements)) {
      const key = tbl.toLowerCase();
      const target = next[key];
      const targets = indicesByTable[key] ?? [];
      if (!target) continue;
      targets.forEach((rowIdx, i) => {
        const repl = (replRows as Record<string, unknown>[])[i];
        if (repl && rowIdx < target.length) {
          target[rowIdx] = repl;
        }
      });
    }

    current = next;
    canonical = toCanonical(current, entityModel);
    validation = validateDataset(canonical, entityModel);
    attempt++;
  }

  const failuresByConstraint: Record<string, number> = {};
  for (const f of validation.failures) {
    failuresByConstraint[f.constraint] =
      (failuresByConstraint[f.constraint] ?? 0) + 1;
  }
  const failuresByTable: Record<string, number> = {};
  for (const f of validation.failures) {
    failuresByTable[f.table] = (failuresByTable[f.table] ?? 0) + 1;
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
      failuresByConstraint,
      failuresByTable,
      sampleFailures: validation.failures.slice(0, 5).map((f) => ({
        table: f.table,
        rowIndex: f.rowIndex,
        column: f.column ?? null,
        constraint: f.constraint,
        detail: f.detail,
      })),
    },
  );
  await setRunStep(
    runId,
    "repair",
    validation.failures.length === 0 ? "succeeded" : "failed",
    validation.failures.length === 0
      ? attempt === 0
        ? "no failures to repair"
        : `cleared ${attempt} round(s) of failures`
      : `${validation.failures.length} unresolved after ${attempt} attempt(s)`,
    {
      attempts: attempt,
      cap: REPAIR_RETRY_CAP,
      unresolved: validation.failures.length,
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
) {
  "use step";
  await setRunStep(runId, "persist", "running");
  await setRunDataset(runId, canonicalDataset);
  const finalStatus = decideFinalStatus(report);
  await setRunStatus(runId, finalStatus);
  const totalRows = Object.values(canonicalDataset.tables).reduce(
    (sum, rows) => sum + rows.length,
    0,
  );
  await setRunStep(
    runId,
    "persist",
    "succeeded",
    `persisted · status ${finalStatus}`,
    {
      totalRows,
      tableCount: canonicalDataset.tableOrder.length,
      finalStatus,
    },
  );
}
stepPersist.maxRetries = 0;

// ---- Workflow ----

export async function runWorkflow(input: RunWorkflowInput) {
  "use workflow";

  const meta = getWorkflowMetadata();
  const runId = meta.workflowRunId;

  await stepInit(runId, input);
  const entityModel = await stepParse(runId, input.schema);
  const plan = await stepPlan(runId, entityModel, input.context);

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

  const rawDataset = await stepGenerate(
    runId,
    entityModel,
    plan,
    input.context,
    input.volume,
  );
  const { canonicalDataset, validation } = await stepValidateAndRepair(
    runId,
    entityModel,
    plan,
    rawDataset,
    input.context,
    input.volume,
  );
  const evaluations = await stepPredicateEvaluate(runId, plan, canonicalDataset);
  const report = await stepScore(runId, plan, validation, evaluations);
  await stepPersist(runId, canonicalDataset, report);

  return {
    runId,
    status: decideFinalStatus(report),
  };
}
