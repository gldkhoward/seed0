/**
 * Tasks 2.4 + 2.7 + 2.8: seed data generator wrapped around two
 * distinct bounded retry loops.
 *
 *   Generation-step retry (2.8) — invokes the LLM, shape-validates
 *     the result, retries the LLM call up to `shapeRetryCap` times
 *     when shape validation rejects. Does NOT invoke constraint
 *     validation.
 *
 *   Repair loop (2.7) — once shape validation passes, runs the
 *     deterministic constraint validator; if any failures are found
 *     and we are below `repairRetryCap`, regenerates the offending
 *     rows in place and re-validates. Stops on success, on cap
 *     exhaustion, or when the LLM call itself errors.
 *
 * The two caps are separately configured (D4). No other automatic
 * retry happens in this module.
 */

import { z } from "zod";
import { structuredOutput } from "./ai";
import { toCanonical } from "./canonical";
import {
  StructuralShapeError,
  validateShape,
  type RawDataset,
  type RawRow,
} from "./shape-validate";
import type {
  CanonicalDataset,
  ConstraintFailure,
  EntityModel,
  ScenarioPlan,
} from "./types";
import { validateDataset } from "./validate";

export type GeneratorOptions = {
  llmModel: string;
  shapeRetryCap?: number;
  repairRetryCap?: number;
};

export type GenerateInput = {
  entityModel: EntityModel;
  context: string;
  plan: ScenarioPlan;
  volume: number;
};

export class GenerationFailedError extends Error {
  readonly attempts: number;
  readonly lastIssues: readonly string[];
  constructor(attempts: number, lastIssues: readonly string[]) {
    super(
      `Generation step failed structural shape validation after ${attempts} attempt(s): ${lastIssues.join("; ")}`,
    );
    this.name = "GenerationFailedError";
    this.attempts = attempts;
    this.lastIssues = lastIssues;
  }
}

/**
 * Workflow-level entry point for a single generation attempt. Returns
 * raw (pre-shape-validation) model output; the caller (the Workflow
 * step) owns the bounded shape-retry loop so each retry can be made
 * visible via run-step status updates.
 */
export interface GenerateSeedDataInput {
  model: EntityModel;
  plan: ScenarioPlan;
  volume: number;
  productContext: string;
  llmModel: string;
  repairHint?: string;
}

export async function generateSeedData(
  input: GenerateSeedDataInput,
): Promise<unknown> {
  return callGenerator(
    {
      entityModel: input.model,
      plan: input.plan,
      volume: input.volume,
      context: input.productContext,
    },
    input.llmModel,
    input.repairHint,
  );
}

/**
 * Workflow-level repair entry point. Returns a by-table map of
 * replacement rows in failure order; the caller stitches them back
 * into the canonical dataset by index.
 */
export interface GenerateRepairFailure {
  table: string;
  index: number;
  reason: string;
  row?: Record<string, unknown>;
}

export interface GenerateRepairInput {
  model: EntityModel;
  plan: ScenarioPlan;
  volume: number;
  productContext: string;
  llmModel: string;
  failures: readonly GenerateRepairFailure[];
}

export async function generateRepair(
  input: GenerateRepairInput,
): Promise<Record<string, Record<string, unknown>[]>> {
  const adapted: ConstraintFailure[] = input.failures.map((f) => ({
    table: f.table,
    rowIndex: f.index,
    column: "",
    constraint: "check",
    detail: f.reason,
  }));
  const current: RawDataset = {};
  for (const f of input.failures) {
    if (!current[f.table]) current[f.table] = [];
    while (current[f.table]!.length <= f.index) {
      current[f.table]!.push({});
    }
    current[f.table]![f.index] = (f.row ?? {}) as RawRow;
  }
  return callRepair(
    {
      entityModel: input.model,
      plan: input.plan,
      volume: input.volume,
      context: input.productContext,
    },
    input.llmModel,
    current,
    adapted,
  );
}

export function createGenerator(options: GeneratorOptions) {
  const shapeRetryCap = Math.max(1, options.shapeRetryCap ?? 3);
  const repairRetryCap = Math.max(0, options.repairRetryCap ?? 3);

  return {
    async generate(input: GenerateInput): Promise<CanonicalDataset> {
      const dataset = await callWithShapeRetry(input, options.llmModel, shapeRetryCap);
      const repaired = await runRepairLoop(
        input,
        options.llmModel,
        repairRetryCap,
        dataset,
      );
      return toCanonical(repaired, input.entityModel);
    },
  };
}

async function callWithShapeRetry(
  input: GenerateInput,
  llmModel: string,
  cap: number,
): Promise<RawDataset> {
  let hint: string | undefined;
  let lastIssues: readonly string[] = [];
  for (let attempt = 1; attempt <= cap; attempt++) {
    const raw = await callGenerator(input, llmModel, hint);
    try {
      return validateShape(raw, input.entityModel);
    } catch (err) {
      if (err instanceof StructuralShapeError) {
        lastIssues = err.issues.map((i) => `${i.path}: ${i.message}`);
        hint = [
          `Previous output failed structural shape validation:`,
          ...lastIssues.slice(0, 5).map((s) => `- ${s}`),
          `Return only known tables/columns; the response must be a JSON object`,
          `keyed by lowercase table name, each value an array of row objects.`,
        ].join("\n");
        continue;
      }
      throw err;
    }
  }
  throw new GenerationFailedError(cap, lastIssues);
}

async function runRepairLoop(
  input: GenerateInput,
  llmModel: string,
  cap: number,
  initial: RawDataset,
): Promise<RawDataset> {
  let current = initial;
  for (let attempt = 0; attempt <= cap; attempt++) {
    const canonical = toCanonical(current, input.entityModel);
    const report = validateDataset(canonical, input.entityModel);
    if (report.failures.length === 0) return current;
    if (attempt === cap) return current;
    let replacement: RawDataset;
    try {
      replacement = await callRepair(
        input,
        llmModel,
        current,
        report.failures,
      );
    } catch {
      // Repair call itself errored: surface what we have. The remaining
      // failures show up in the readiness report (2.11).
      return current;
    }
    current = applyReplacements(current, replacement, report.failures);
  }
  return current;
}

const GENERATOR_SYSTEM = `You generate seed data for a relational schema.

Inputs: an entity model, a confirmed scenario plan (each scenario has a
machine-checked predicate over a single table), and a target volume.

Produce a JSON object keyed by lowercase table name. Each value is an
array of row objects keyed by the model's lowercase column names. Aim
for every scenario predicate to be satisfied by at least one row.

Hard rules:
- Stay within the specified tables and columns. Do not invent either.
- Respect NOT NULL, enum value sets, CHECK constraints, foreign keys,
  and UNIQUE keys. Foreign-key values must exist on the target table
  you also emit.
- Use ISO-8601 strings for timestamps and dates. Use plain JSON scalars
  for everything else (boolean, number, string, null). Decimal values
  may be returned as strings to preserve precision.
- Do not return SQL. Do not return Markdown. Only the JSON object.`;

const REPAIR_SYSTEM = `${GENERATOR_SYSTEM}

You are in repair mode. You receive specific rows that failed
deterministic validation, with the exact reason for each. Produce
*replacement* rows ONLY for the listed (table, rowIndex) failures.
Return the same JSON-by-table shape; for each listed table, the array
order must correspond to the order of failures for that table in the
input.`;

const rawDatasetSchema = z.record(
  z.string(),
  z.array(z.record(z.string(), z.unknown())),
);

async function callGenerator(
  input: GenerateInput,
  llmModel: string,
  hint?: string,
): Promise<unknown> {
  const prompt = buildGeneratorPrompt(input, hint);
  const { object } = await structuredOutput({
    model: llmModel,
    schema: rawDatasetSchema,
    system: GENERATOR_SYSTEM,
    prompt,
  });
  return object;
}

async function callRepair(
  input: GenerateInput,
  llmModel: string,
  current: RawDataset,
  failures: readonly ConstraintFailure[],
): Promise<RawDataset> {
  const grouped = groupFailures(failures, current);
  const prompt = [
    `Product context:`,
    input.context.trim(),
    "",
    `Entity model:`,
    describeModel(input.entityModel),
    "",
    `Confirmed scenarios:`,
    describePlan(input.plan),
    "",
    `Failures to repair (one replacement row per failure, in the order shown):`,
    JSON.stringify(grouped, null, 2),
  ].join("\n");

  const { object } = await structuredOutput({
    model: llmModel,
    schema: rawDatasetSchema,
    system: REPAIR_SYSTEM,
    prompt,
  });
  // Repair output is reused as a sparse RawDataset of replacement rows.
  return object as RawDataset;
}

function buildGeneratorPrompt(input: GenerateInput, hint?: string): string {
  const parts = [
    `Product context:`,
    input.context.trim(),
    "",
    `Entity model:`,
    describeModel(input.entityModel),
    "",
    `Confirmed scenarios (each must be satisfied by at least one row):`,
    describePlan(input.plan),
    "",
    `Target total volume: ${input.volume} rows across tables (distribute proportionally).`,
  ];
  if (hint) parts.push("", `Additional guidance:`, hint);
  return parts.join("\n");
}

function describeModel(model: EntityModel): string {
  return model.tables
    .map((t) => {
      const cols = t.columns
        .map((c) => {
          const bits: string[] = [c.type];
          if (!c.nullable) bits.push("not null");
          if (c.primaryKey) bits.push("primary key");
          else if (c.unique) bits.push("unique");
          if (c.references)
            bits.push(`→ ${c.references.table}.${c.references.column}`);
          if (c.enumValues) bits.push(`enum=[${c.enumValues.join("|")}]`);
          if (c.check) bits.push(`check=${c.check}`);
          return `    ${c.name}: ${bits.join(", ")}`;
        })
        .join("\n");
      return `  ${t.name}:\n${cols}`;
    })
    .join("\n");
}

function describePlan(plan: ScenarioPlan): string {
  return plan.scenarios
    .map(
      (s) =>
        `- ${s.id} (${s.predicate.table}): ${s.name}\n    where=${JSON.stringify(s.predicate.where)}`,
    )
    .join("\n");
}

type GroupedFailures = Record<
  string,
  Array<{ rowIndex: number; reason: string; row: RawRow }>
>;

function groupFailures(
  failures: readonly ConstraintFailure[],
  current: RawDataset,
): GroupedFailures {
  const out: GroupedFailures = {};
  const seen = new Set<string>();
  for (const f of failures) {
    const key = `${f.table}#${f.rowIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (out[f.table] ||= []).push({
      rowIndex: f.rowIndex,
      reason: `${f.constraint}: ${f.detail}`,
      row: current[f.table]?.[f.rowIndex] ?? {},
    });
  }
  return out;
}

function applyReplacements(
  current: RawDataset,
  replacement: RawDataset,
  failures: readonly ConstraintFailure[],
): RawDataset {
  const next: RawDataset = {};
  for (const [t, rows] of Object.entries(current)) next[t] = rows.map((r) => ({ ...r }));

  // Per-table ordered list of unique failed indices.
  const orderedTargets: Record<string, number[]> = {};
  for (const f of failures) {
    (orderedTargets[f.table] ||= []);
    if (!orderedTargets[f.table].includes(f.rowIndex)) {
      orderedTargets[f.table].push(f.rowIndex);
    }
  }
  for (const [table, rows] of Object.entries(replacement)) {
    const targets = orderedTargets[table.toLowerCase()] ?? [];
    const tableLower = table.toLowerCase();
    if (!next[tableLower]) continue;
    targets.forEach((rowIndex, i) => {
      const repl = rows[i];
      if (!repl) return;
      const normalized: RawRow = {};
      for (const [k, v] of Object.entries(repl)) normalized[k.toLowerCase()] = v;
      next[tableLower][rowIndex] = normalized;
    });
  }
  return next;
}
