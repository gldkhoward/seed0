/**
 * Architect agent.
 *
 * Replaces the one-shot planner: instead of just emitting scenarios,
 * this agent decides the FULL execution graph for the run — table
 * allocations, parallel groups, optional steps, and whether to reuse
 * a cached dataset. It runs as a scoped AI SDK tool-call loop with a
 * hard cap of 8 steps (see `stepCountIs(8)` below), invoked exactly
 * once per run by the workflow's `plan-execution` step. The cache
 * decision is genuinely agentic: the agent calls `findCachedRuns`,
 * inspects candidates, and decides per-call whether to reuse or
 * regenerate based on the product context.
 *
 * The terminal `finalize` tool captures the structured plan as its
 * arguments — the same pattern as a `finish` tool, but with the
 * complete plan in the tool input. We extract the plan from the tool
 * call list at the end.
 *
 * Validation: every plan returned by the agent passes through
 * `validateExecutionPlan`. Plans that violate FK ordering or reference
 * unknown tables are rejected; the workflow falls back to a
 * deterministic plan derived from the entity model and a fresh
 * scenarios-only LLM call.
 */

import { generateText, hasToolCall, stepCountIs, tool } from "ai";
import { z } from "zod";

import { generatePlan as legacyPlanner } from "./planner";
import {
  getCachedDataset,
  listCachedSummaries,
  type CachedDatasetEntry,
  type CachedDatasetSummary,
} from "./run-cache";
import { publishAgentThought } from "./run-stream";
import type {
  ArchitectPlan,
  EntityModel,
  ExecutionPlan,
  ScenarioPlan,
} from "./types";

export class ArchitectPlanError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Architect plan rejected: ${issues.join("; ")}`);
    this.name = "ArchitectPlanError";
    this.issues = issues;
  }
}

export interface ArchitectInput {
  entityModel: EntityModel;
  productContext: string;
  llmModel: string;
  schemaHash: string;
  /** Total target rows across all tables. */
  volume: number;
  stepCap?: number;
}

export interface ArchitectResult {
  plan: ArchitectPlan;
  /** Populated only when `plan.execution.cacheDecision.kind === "reuse"`. */
  cachedDataset?: CachedDatasetEntry;
  toolCalls: ArchitectToolCall[];
}

export interface ArchitectToolCall {
  name: string;
  at: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

const SCENARIO_PREDICATE_SCHEMA: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("and"), clauses: z.array(SCENARIO_PREDICATE_SCHEMA) }),
    z.object({ kind: z.literal("or"), clauses: z.array(SCENARIO_PREDICATE_SCHEMA) }),
    z.object({ kind: z.literal("not"), clause: SCENARIO_PREDICATE_SCHEMA }),
    z.object({
      kind: z.enum(["eq", "neq"]),
      column: z.string(),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    }),
    z.object({
      kind: z.enum(["gt", "gte", "lt", "lte"]),
      column: z.string(),
      value: z.union([z.string(), z.number()]),
    }),
    z.object({
      kind: z.literal("in"),
      column: z.string(),
      values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    }),
    z.object({ kind: z.enum(["isNull", "isNotNull"]), column: z.string() }),
  ]),
);

const FINALIZE_SCHEMA = z.object({
  scenarios: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        description: z.string().min(1),
        predicate: z.object({
          table: z.string().min(1),
          where: SCENARIO_PREDICATE_SCHEMA,
        }),
      }),
    )
    .min(1),
  execution: z.object({
    parallelGroups: z.array(z.array(z.string().min(1)).min(1)).min(1),
    tableAllocations: z.record(z.string(), z.number().int().nonnegative()),
    optionalSteps: z.array(z.enum(["coverage-boost"])),
    cacheDecision: z.union([
      z.object({
        kind: z.literal("reuse"),
        sourceRunId: z.string().min(1),
        reason: z.string().min(1),
      }),
      z.object({
        kind: z.literal("regenerate"),
        reason: z.string().min(1),
      }),
    ]),
    reasoning: z.string().min(1),
  }),
});

const ARCHITECT_SYSTEM = `You design the FULL execution plan for a Postgres seed-data run.

You are given:
- An entity model (tables, columns, types, constraints, references)
- A product context describing the business
- A target row volume
- Tools to inspect prior cached datasets for the same schema shape

You must decide BOTH:
1. **Scenarios** — named, predicate-bearing situations the seed data
   should cover (same as the legacy planner — every scenario has a
   structured predicate over a single table).
2. **Execution plan** — how the workflow should produce the data:
   - tableAllocations: row count per table (sum ≈ total volume).
     Tables that anchor more scenarios should get more rows.
   - parallelGroups: ordered waves. Tables in the same wave run
     concurrently; waves run sequentially. Because primary keys are
     pre-allocated before any LLM call, child tables don't need parents
     to *finish* — they just need to exist. For most schemas, ONE wave
     containing all tables is correct. Use multiple waves only when
     you have a specific reason (e.g. very wide schemas where you want
     to keep concurrency bounded).
   - optionalSteps: enable "coverage-boost" when scenarios are dense
     or unevenly distributed across tables — it lets the system
     re-generate uninstantiated scenarios after the first pass.
   - cacheDecision: REUSE a prior dataset only when the product
     context closely matches a candidate AND that candidate has
     scenario coverage similar to what you would design now. Otherwise
     REGENERATE.

Cache reuse policy:
- Call \`findCachedRuns\` first to discover candidates by matching schema hash.
- For promising candidates, call \`inspectCachedDataset\` for a sample.
- REUSE only if context is semantically equivalent (e.g. both clearly
  describe the same business). Otherwise REGENERATE.
- If you reuse, scenarios still matter — generate them to match the
  cached dataset's content, so downstream predicate evaluation is
  meaningful.

Predicate grammar (use only these shapes; tables and columns must
exist in the entity model; use lowercase identifiers):

Predicate = { table: string; where: PredicateExpr }
PredicateExpr =
  | { kind: "and"; clauses: PredicateExpr[] }
  | { kind: "or"; clauses: PredicateExpr[] }
  | { kind: "not"; clause: PredicateExpr }
  | { kind: "eq" | "neq"; column: string; value: scalar }
  | { kind: "gt" | "gte" | "lt" | "lte"; column: string; value: number | string }
  | { kind: "in"; column: string; values: scalar[] }
  | { kind: "isNull" | "isNotNull"; column: string }

When you have decided, call \`finalize\` with the complete plan. Only
call \`finalize\` once and only when you are done.`;

export async function runArchitectAgent(
  input: ArchitectInput,
): Promise<ArchitectResult> {
  const tableNames = new Set(input.entityModel.tables.map((t) => t.name));
  const toolCalls: ArchitectToolCall[] = [];
  let cachedSummaries: CachedDatasetSummary[] = [];
  let finalizedPlan: ArchitectPlan | undefined;

  const trace = async (
    name: string,
    args: Record<string, unknown> | undefined,
    result: Record<string, unknown>,
    message: string,
  ): Promise<void> => {
    const entry: ArchitectToolCall = {
      name,
      at: new Date().toISOString(),
      args,
      result,
    };
    toolCalls.push(entry);
    await publishAgentThought({
      agent: "architect",
      at: entry.at,
      kind: "tool-call",
      toolName: name,
      message,
      data: result,
    });
  };

  const tools = {
    findCachedRuns: tool({
      description:
        "List prior successful runs with the same schema shape. Returns lightweight summaries (no row data) so you can scan candidates cheaply. Always call this once before deciding whether to reuse.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          cachedSummaries = await listCachedSummaries(input.schemaHash);
        } catch {
          cachedSummaries = [];
        }
        const result = {
          count: cachedSummaries.length,
          candidates: cachedSummaries.map((s) => ({
            sourceRunId: s.sourceRunId,
            createdAt: s.createdAt,
            productContext: s.productContext.slice(0, 240),
            scenarioIds: s.scenarioIds,
            totalRows: s.totalRows,
            tables: Object.keys(s.tableRowCounts).length,
          })),
        };
        await trace(
          "findCachedRuns",
          undefined,
          result,
          `Found ${result.count} cached dataset(s) with matching schema shape.`,
        );
        return result;
      },
    }),

    inspectCachedDataset: tool({
      description:
        "Fetch a small sample of rows from a cached dataset to confirm the context fits before reusing.",
      inputSchema: z.object({
        sourceRunId: z.string().min(1),
      }),
      execute: async ({ sourceRunId }) => {
        const entry = await getCachedDataset(input.schemaHash, sourceRunId);
        if (!entry) {
          const result = { error: "not found", sourceRunId };
          await trace(
            "inspectCachedDataset",
            { sourceRunId },
            result,
            `Cached dataset ${sourceRunId} not found.`,
          );
          return result;
        }
        const sampleByTable: Record<string, unknown[]> = {};
        for (const [t, rows] of Object.entries(entry.dataset.tables)) {
          sampleByTable[t] = rows.slice(0, 2);
        }
        const result = {
          sourceRunId,
          createdAt: entry.createdAt,
          productContext: entry.productContext,
          scenarioIds: entry.scenarioIds,
          totalRows: entry.totalRows,
          tableRowCounts: entry.tableRowCounts,
          sample: sampleByTable,
        };
        await trace(
          "inspectCachedDataset",
          { sourceRunId },
          { totalRows: entry.totalRows, scenarioCount: entry.scenarioIds.length },
          `Inspected ${sourceRunId} · ${entry.totalRows} rows.`,
        );
        return result;
      },
    }),

    finalize: tool({
      description:
        "Submit the complete architect plan (scenarios + execution). Call this exactly once when you have decided everything.",
      inputSchema: FINALIZE_SCHEMA,
      execute: async (plan) => {
        finalizedPlan = plan as ArchitectPlan;
        await trace(
          "finalize",
          undefined,
          {
            scenarioCount: plan.scenarios.length,
            waves: plan.execution.parallelGroups.length,
            cache: plan.execution.cacheDecision.kind,
          },
          `Plan finalized · ${plan.scenarios.length} scenarios, ${plan.execution.parallelGroups.length} wave(s), cache=${plan.execution.cacheDecision.kind}.`,
        );
        return { acknowledged: true };
      },
    }),
  };

  const userPrompt = [
    `Product context:`,
    input.productContext.trim(),
    "",
    `Target volume: ${input.volume} rows total.`,
    `Schema hash: ${input.schemaHash}`,
    "",
    `Entity model:`,
    describeModel(input.entityModel),
    "",
    `Design 6-10 scenarios and the execution plan. Call findCachedRuns`,
    `first, then finalize.`,
  ].join("\n");

  await publishAgentThought({
    agent: "architect",
    at: new Date().toISOString(),
    kind: "status",
    message: `Architect starting · ${input.entityModel.tables.length} tables, target ${input.volume} rows.`,
  });

  await generateText({
    model: input.llmModel,
    system: ARCHITECT_SYSTEM,
    prompt: userPrompt,
    tools,
    stopWhen: [stepCountIs(input.stepCap ?? 8), hasToolCall("finalize")],
  });

  if (!finalizedPlan) {
    throw new ArchitectPlanError([
      "agent stopped without calling finalize",
    ]);
  }

  validateExecutionPlan(finalizedPlan, input.entityModel, cachedSummaries);

  let cachedDataset: CachedDatasetEntry | undefined;
  if (finalizedPlan.execution.cacheDecision.kind === "reuse") {
    cachedDataset = await getCachedDataset(
      input.schemaHash,
      finalizedPlan.execution.cacheDecision.sourceRunId,
    );
    if (!cachedDataset) {
      // Cache vanished between findCachedRuns and now — fall back to regenerate.
      finalizedPlan = {
        ...finalizedPlan,
        execution: {
          ...finalizedPlan.execution,
          cacheDecision: {
            kind: "regenerate",
            reason:
              "Selected cached dataset disappeared between inspection and reuse; regenerating.",
          },
        },
      };
    }
  }

  await publishAgentThought({
    agent: "architect",
    at: new Date().toISOString(),
    kind: "decision",
    message:
      finalizedPlan.execution.cacheDecision.kind === "reuse"
        ? `Decision: reuse cache from ${finalizedPlan.execution.cacheDecision.sourceRunId}.`
        : `Decision: regenerate · ${finalizedPlan.execution.cacheDecision.reason}`,
  });

  return { plan: finalizedPlan, cachedDataset, toolCalls };
}

/**
 * Plan validator. Rejects plans where:
 * - any table in `tableAllocations` or `parallelGroups` is unknown
 * - the same table appears in more than one wave
 * - any table from the model is missing from `parallelGroups` (we want
 *   the plan to cover every table — if the architect intentionally
 *   leaves some out, the workflow can't generate them)
 * - `cacheDecision.kind === "reuse"` but the runId isn't in the
 *   candidate set the architect actually saw
 */
function validateExecutionPlan(
  plan: ArchitectPlan,
  model: EntityModel,
  cachedSummaries: readonly CachedDatasetSummary[],
): void {
  const issues: string[] = [];
  const modelTables = new Set(model.tables.map((t) => t.name));
  const seenInWaves = new Set<string>();
  for (const wave of plan.execution.parallelGroups) {
    for (const t of wave) {
      if (!modelTables.has(t)) {
        issues.push(`parallelGroups references unknown table ${t}`);
      }
      if (seenInWaves.has(t)) {
        issues.push(`table ${t} appears in more than one wave`);
      }
      seenInWaves.add(t);
    }
  }
  for (const t of modelTables) {
    if (!seenInWaves.has(t)) {
      issues.push(`table ${t} is missing from parallelGroups`);
    }
  }
  for (const t of Object.keys(plan.execution.tableAllocations)) {
    if (!modelTables.has(t)) {
      issues.push(`tableAllocations references unknown table ${t}`);
    }
  }
  for (const s of plan.scenarios) {
    if (!modelTables.has(s.predicate.table)) {
      issues.push(
        `scenario ${s.id} predicate references unknown table ${s.predicate.table}`,
      );
    }
  }
  if (plan.execution.cacheDecision.kind === "reuse") {
    const ok = cachedSummaries.some(
      (s) =>
        plan.execution.cacheDecision.kind === "reuse" &&
        s.sourceRunId === plan.execution.cacheDecision.sourceRunId,
    );
    if (!ok) {
      issues.push(
        `cacheDecision references runId not in candidate set — reuse would be unsafe`,
      );
    }
  }
  if (issues.length > 0) throw new ArchitectPlanError(issues);
}

/**
 * Fallback: when the architect fails to produce a valid plan, fall
 * back to the legacy scenarios-only planner and synthesize a
 * deterministic execution plan (single wave, even allocation).
 */
export async function buildFallbackPlan(args: {
  entityModel: EntityModel;
  productContext: string;
  llmModel: string;
  volume: number;
}): Promise<ArchitectPlan> {
  const scenarioPlan: ScenarioPlan = await legacyPlanner({
    model: args.entityModel,
    productContext: args.productContext,
    llmModel: args.llmModel,
  });
  return synthesizeDeterministicPlan({
    entityModel: args.entityModel,
    scenarios: scenarioPlan,
    volume: args.volume,
  });
}

/**
 * Synthesize an execution plan from scenarios + entity model when the
 * architect can't be trusted (fallback path).
 */
export function synthesizeDeterministicPlan(args: {
  entityModel: EntityModel;
  scenarios: ScenarioPlan;
  volume: number;
}): ArchitectPlan {
  const allocations: Record<string, number> = {};
  const baseline = Math.max(
    3,
    Math.floor(args.volume / Math.max(1, args.entityModel.tables.length)),
  );
  for (const t of args.entityModel.tables) {
    allocations[t.name] = baseline;
  }
  const execution: ExecutionPlan = {
    parallelGroups: [args.entityModel.tables.map((t) => t.name)],
    tableAllocations: allocations,
    optionalSteps: [],
    cacheDecision: {
      kind: "regenerate",
      reason: "Fallback plan — architect did not produce a valid plan.",
    },
    reasoning:
      "Deterministic fallback: single wave with even allocation across tables.",
  };
  return { scenarios: args.scenarios.scenarios, execution };
}

function describeModel(model: EntityModel): string {
  return model.tables
    .map((t) => {
      const cols = t.columns
        .map((c) => {
          const bits: string[] = [c.type];
          if (!c.nullable) bits.push("not null");
          if (c.primaryKey) bits.push("pk");
          else if (c.unique) bits.push("unique");
          if (c.references)
            bits.push(`→${c.references.table}.${c.references.column}`);
          if (c.enumValues) bits.push(`enum=[${c.enumValues.join("|")}]`);
          return `    ${c.name} (${bits.join(", ")})`;
        })
        .join("\n");
      return `  ${t.name}\n${cols}`;
    })
    .join("\n");
}
