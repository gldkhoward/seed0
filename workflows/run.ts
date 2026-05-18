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
import { generateSeedData, generateRepair } from "@/lib/generator";
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
  ScenarioEvaluation,
  ScenarioPlan,
  ValidationReport,
} from "@/lib/types";

export const RUN_LLM_MODEL = "anthropic/claude-sonnet-4-6";
const SHAPE_RETRY_CAP = 2;
const REPAIR_RETRY_CAP = 3;

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
    await setRunStep(runId, "parse", "succeeded");
    return model;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setRunStep(runId, "parse", "failed", msg);
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
    await setRunPlan(runId, plan);
    await setRunStep(runId, "plan", "succeeded");
    return plan;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setRunStep(runId, "plan", "failed", msg);
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
  let lastError: unknown;
  for (let attempt = 0; attempt <= SHAPE_RETRY_CAP; attempt++) {
    try {
      const raw = await generateSeedData({
        model: entityModel,
        plan,
        volume,
        productContext,
        llmModel: RUN_LLM_MODEL,
        repairHint:
          attempt > 0
            ? "Previous output failed structural shape validation. Return a JSON object keyed by table name (lowercase). Each value must be an array of row objects whose keys are only columns from the entity model."
            : undefined,
      });
      const validated = validateShape(raw, entityModel);
      await setRunStep(runId, "generate", "succeeded");
      return validated;
    } catch (e) {
      lastError = e;
      if (e instanceof StructuralShapeError && attempt < SHAPE_RETRY_CAP) {
        await setRunStep(
          runId,
          "generate",
          "running",
          `shape retry ${attempt + 1}/${SHAPE_RETRY_CAP}`,
        );
        continue;
      }
      const msg = e instanceof Error ? e.message : String(e);
      await setRunStep(runId, "generate", "failed", msg);
      await markRunFailed(runId, `generate: ${msg}`);
      throw new FatalError(msg);
    }
  }
  const msg = lastError instanceof Error ? lastError.message : "shape-retry cap exhausted";
  await setRunStep(runId, "generate", "failed", msg);
  await markRunFailed(runId, `generate: ${msg}`);
  throw new FatalError(msg);
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

  await setRunStep(
    runId,
    "validate",
    "succeeded",
    `${validation.passingRecords}/${validation.totalRecords} passing`,
  );
  await setRunStep(
    runId,
    "repair",
    validation.failures.length === 0 ? "succeeded" : "failed",
    validation.failures.length === 0
      ? "no unresolved failures"
      : `${validation.failures.length} unresolved`,
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
  await setRunStep(
    runId,
    "predicate-evaluate",
    "succeeded",
    `${instantiated}/${plan.scenarios.length} scenarios instantiated`,
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
  await setRunStep(runId, "score", "succeeded");
  return report;
}
stepScore.maxRetries = 0;

async function stepPersist(runId: string, canonicalDataset: CanonicalDataset) {
  "use step";
  await setRunStep(runId, "persist", "running");
  await setRunDataset(runId, canonicalDataset);
  await setRunStatus(runId, "succeeded");
  await setRunStep(runId, "persist", "succeeded");
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
  await stepScore(runId, plan, validation, evaluations);
  await stepPersist(runId, canonicalDataset);

  return { runId, status: "succeeded" as const };
}
