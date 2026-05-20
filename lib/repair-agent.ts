/**
 * Agentic repair loop.
 *
 * The validate-repair step gives a Sonnet agent a set of failures and
 * a tool surface for fixing them. Runs as a scoped AI SDK tool-call
 * loop with a hard cap of ~20-24 steps (`stepCountIs(stepCap)` below),
 * invoked exactly once per run by the workflow's `validate-repair`
 * step — only when the deterministic validator has surfaced failures.
 *
 * The agent chooses strategy per failure: composite-unique on a
 * junction table → call `getUnusedFkPairs` then `replaceRow`; CHECK
 * violation → just `replaceRow` with corrected data; impossible
 * failure → call `deterministicFix` and let the pure-code fallback
 * handle it.
 *
 * Tools verify, not the model: replaceRow re-validates the row after
 * mutation, so the agent can't "fix" something by introducing a new
 * violation. Each tool call publishes a trace event so the UI can
 * render a nested timeline under the Repair step.
 */

import { generateText, hasToolCall, stepCountIs, tool } from "ai";
import { z } from "zod";

import { toCanonical } from "./canonical";
import { attemptDeterministicFix } from "./repair-deterministic";
import type { RawDataset, RawRow } from "./shape-validate";
import type {
  ConstraintFailure,
  EntityModel,
  ScalarLiteral,
  ScenarioPlan,
  ValidationReport,
} from "./types";
import { validateDataset } from "./validate";

export interface ToolCallTrace {
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  at: string;
  ok: boolean;
}

export interface RepairAgentInput {
  initialDataset: RawDataset;
  initialFailures: readonly ConstraintFailure[];
  entityModel: EntityModel;
  plan: ScenarioPlan;
  productContext: string;
  llmModel: string;
  stepCap?: number;
  onToolCall?: (event: ToolCallTrace) => void | Promise<void>;
}

export interface RepairAgentResult {
  dataset: RawDataset;
  validation: ValidationReport;
  toolCalls: ToolCallTrace[];
  stoppedReason: "finish" | "step-cap" | "no-failures" | "error";
  errorMessage?: string;
}

const AGENT_SYSTEM = `You are a deterministic data-repair agent for a Postgres seed dataset.

You are given a list of validation failures (NOT NULL, type, enum,
CHECK, unique, foreign_key). Your job is to call tools that fix each
failure without introducing new ones, then call \`finish\` when there
are no more failures (or no more that can be fixed).

Decision tree (in order of preference):
1. **Look at \`listFailures\` first.** If most failures share the same
   (constraint, table, column) — e.g. 800 single-unique failures on
   \`packages.tracking_number\` — that is a BULK pattern. Use
   \`bulkDeterministicFix\` to clear them in a single call. Never call
   \`deterministicFix\` row-by-row when more than ~10 failures share
   the same shape; it wastes tool calls and runs out the step budget.
2. **For a small number of mixed / structural failures**, call
   \`deterministicFix\` per row. Use this when each failure needs an
   individually-considered fix.
3. **For composite-unique failures on FK columns (junction tables),**
   start with \`getUnusedFkPairs\` to see what combinations are free,
   then use \`replaceRow\`. Or call \`deterministicFix\` to let the
   system pick a fresh pair.
4. **For foreign-key violations,** call \`getFkPool\` then
   \`replaceRow\`, or \`deterministicFix\` for a quick deterministic
   substitute.
5. **For NOT NULL / single-column unique / type / enum failures,**
   call \`replaceRow\` with a corrected row only when you have a
   specific business value in mind. Otherwise prefer
   \`bulkDeterministicFix\`.

Hard rules:
- Never invent foreign-key values — read pools with \`getFkPool\`.
- After a few unproductive attempts on the same row, call
  \`deterministicFix\` instead of guessing again.
- Call \`finish\` when failures are zero or no further progress is
  possible. Include a one-line reason.

Tool outputs always include the current total failure count so you
can decide whether to keep going.`;

export async function runRepairAgent(
  input: RepairAgentInput,
): Promise<RepairAgentResult> {
  // Mutable working dataset — tools edit it in place.
  const working: RawDataset = deepCloneDataset(input.initialDataset);
  const tableNames = new Set(input.entityModel.tables.map((t) => t.name));

  let currentValidation = revalidate(working, input.entityModel);
  const toolCalls: ToolCallTrace[] = [];

  const trace = async (
    name: string,
    args: Record<string, unknown>,
    result: Record<string, unknown>,
    ok: boolean,
  ): Promise<void> => {
    const event: ToolCallTrace = {
      name,
      args,
      result,
      at: new Date().toISOString(),
      ok,
    };
    toolCalls.push(event);
    if (input.onToolCall) await input.onToolCall(event);
  };

  // -------------------- Tool implementations --------------------

  const tools = {
    listFailures: tool({
      description:
        "Return the current list of validation failures. Use this any time you want a fresh view of what's left.",
      inputSchema: z.object({}),
      execute: async () => {
        const summary = summariseFailures(currentValidation.failures);
        const result = {
          totalFailures: currentValidation.failures.length,
          byConstraint: summary.byConstraint,
          byTable: summary.byTable,
          sample: currentValidation.failures.slice(0, 20).map(failureShape),
        };
        await trace("listFailures", {}, result, true);
        return result;
      },
    }),

    getFkPool: tool({
      description:
        "Return valid foreign-key values for a column. The pool is the set of values currently present in the parent table's referenced column.",
      inputSchema: z.object({
        table: z.string(),
        column: z.string(),
      }),
      execute: async ({ table, column }) => {
        if (!tableNames.has(table)) {
          const result = { error: `unknown table ${table}` };
          await trace("getFkPool", { table, column }, result, false);
          return result;
        }
        const tableDef = input.entityModel.tables.find((t) => t.name === table)!;
        const col = tableDef.columns.find((c) => c.name === column);
        if (!col?.references) {
          const result = { error: `${table}.${column} is not a foreign key` };
          await trace("getFkPool", { table, column }, result, false);
          return result;
        }
        const parentRows = working[col.references.table] ?? [];
        const values = uniqueScalars(
          parentRows.map((r) => r[col.references!.column]),
        );
        const result = {
          parentTable: col.references.table,
          parentColumn: col.references.column,
          count: values.length,
          sample: values.slice(0, 50),
        };
        await trace("getFkPool", { table, column }, result, true);
        return result;
      },
    }),

    getUnusedFkPairs: tool({
      description:
        "For a junction-table-style composite unique constraint, return combinations of FK values that are NOT yet used by any row. Use this before replaceRow when fixing composite-unique failures.",
      inputSchema: z.object({
        table: z.string(),
        fkColumns: z.array(z.string()).min(2),
      }),
      execute: async ({ table, fkColumns }) => {
        if (!tableNames.has(table)) {
          const result = { error: `unknown table ${table}` };
          await trace("getUnusedFkPairs", { table, fkColumns }, result, false);
          return result;
        }
        const tableDef = input.entityModel.tables.find((t) => t.name === table)!;
        const pools: ScalarLiteral[][] = fkColumns.map((cn) => {
          const c = tableDef.columns.find((cc) => cc.name === cn);
          if (!c?.references) return [];
          const parentRows = working[c.references.table] ?? [];
          return uniqueScalars(parentRows.map((r) => r[c.references!.column]));
        });
        if (pools.some((p) => p.length === 0)) {
          const result = {
            error: `at least one column has no candidate FK values (cols=${fkColumns.join(",")})`,
          };
          await trace("getUnusedFkPairs", { table, fkColumns }, result, false);
          return result;
        }
        const used = collectUsedTuples(working[table] ?? [], fkColumns);
        const pairs = enumerateUnused(pools, used, 100);
        const result = {
          remaining: pairs.length,
          columns: fkColumns,
          sample: pairs,
        };
        await trace("getUnusedFkPairs", { table, fkColumns }, result, true);
        return result;
      },
    }),

    replaceRow: tool({
      description:
        "Replace a row at (table, rowIndex) with a new row. The replacement is validated immediately; this tool returns any remaining failures on the touched row and the new total. Include every NOT NULL column; FK columns must use valid pool values.",
      inputSchema: z.object({
        table: z.string(),
        rowIndex: z.number().int().min(0),
        row: z.record(z.string(), z.unknown()),
      }),
      execute: async ({ table, rowIndex, row }) => {
        if (!tableNames.has(table)) {
          const result = { error: `unknown table ${table}` };
          await trace("replaceRow", { table, rowIndex }, result, false);
          return result;
        }
        const rows = working[table] ?? [];
        if (rowIndex >= rows.length) {
          const result = { error: `rowIndex ${rowIndex} out of range for ${table}` };
          await trace("replaceRow", { table, rowIndex }, result, false);
          return result;
        }
        rows[rowIndex] = { ...row };
        currentValidation = revalidate(working, input.entityModel);
        const rowFailures = currentValidation.failures.filter(
          (f) => f.table === table && f.rowIndex === rowIndex,
        );
        const result = {
          ok: rowFailures.length === 0,
          rowFailures: rowFailures.map(failureShape),
          totalFailures: currentValidation.failures.length,
        };
        await trace(
          "replaceRow",
          { table, rowIndex, columns: Object.keys(row) },
          result,
          result.ok,
        );
        return result;
      },
    }),

    deterministicFix: tool({
      description:
        "Apply a deterministic, code-only fix to a SINGLE row. Looks at the row's outstanding failures and picks the best strategy (fresh unused FK pair for composite-unique, valid parent ID for FK violations, fresh value for single-column unique, type default for NOT NULL). Use this for one-off structural fixes. For repetitive same-shape failures across many rows, call `bulkDeterministicFix` instead.",
      inputSchema: z.object({
        table: z.string(),
        rowIndex: z.number().int().min(0),
      }),
      execute: async ({ table, rowIndex }) => {
        const fix = attemptDeterministicFix(
          {
            model: input.entityModel,
            dataset: working,
            failures: currentValidation.failures,
          },
          table,
          rowIndex,
        );
        if (fix.ok) {
          currentValidation = revalidate(working, input.entityModel);
        }
        const result = {
          ok: fix.ok,
          applied: fix.applied ?? null,
          detail: fix.detail,
          totalFailures: currentValidation.failures.length,
        };
        await trace("deterministicFix", { table, rowIndex }, result, fix.ok);
        return result;
      },
    }),

    bulkDeterministicFix: tool({
      description:
        "Apply the deterministic fix strategy to EVERY row currently matching the filter, in one pass. Use this when many failures share the same shape — e.g. 800 single-unique violations on packages.tracking_number, or every row in a table missing the same NOT NULL column. Vastly cheaper than calling deterministicFix once per row. Returns aggregate stats: how many rows were touched, how many strategies fired by kind, and the new total-failure count.",
      inputSchema: z.object({
        table: z.string().optional(),
        column: z.string().optional(),
        constraint: z
          .enum(["not_null", "foreign_key", "enum", "check", "unique", "type"])
          .optional(),
      }),
      execute: async ({ table, column, constraint }) => {
        // Snapshot the failure set we're going to act on. We resolve
        // failures into one fix-per-row keyed by (table, rowIndex)
        // because attemptDeterministicFix is row-scoped and uses the
        // row's outstanding-failure list to choose a strategy — there
        // is no benefit to calling it twice on the same row.
        const matching = currentValidation.failures.filter((f) => {
          if (table && f.table !== table) return false;
          if (constraint && f.constraint !== constraint) return false;
          if (column) {
            const fcol = f.column ?? "";
            if (!fcol.split(",").map((s) => s.trim()).includes(column)) {
              return false;
            }
          }
          return true;
        });
        if (matching.length === 0) {
          const result = {
            ok: true,
            matched: 0,
            attempted: 0,
            fixed: 0,
            byApplied: {},
            firstErrors: [] as string[],
            totalFailures: currentValidation.failures.length,
          };
          await trace(
            "bulkDeterministicFix",
            { table, column, constraint },
            result,
            true,
          );
          return result;
        }

        // De-duplicate down to one (table, rowIndex) pair per row.
        const rowKeys = new Set<string>();
        const targets: Array<{ table: string; rowIndex: number }> = [];
        for (const f of matching) {
          const key = `${f.table} ${f.rowIndex}`;
          if (rowKeys.has(key)) continue;
          rowKeys.add(key);
          targets.push({ table: f.table, rowIndex: f.rowIndex });
        }

        const ctx = {
          model: input.entityModel,
          dataset: working,
          failures: currentValidation.failures,
        };
        const byApplied: Record<string, number> = {};
        const firstErrors: string[] = [];
        let fixed = 0;
        for (const t of targets) {
          const fix = attemptDeterministicFix(ctx, t.table, t.rowIndex);
          if (fix.ok) {
            fixed++;
            const key = fix.applied ?? "unknown";
            byApplied[key] = (byApplied[key] ?? 0) + 1;
          } else if (firstErrors.length < 5) {
            firstErrors.push(`${t.table}[${t.rowIndex}]: ${fix.detail}`);
          }
        }
        // One revalidation at the end — orders of magnitude cheaper
        // than revalidating after every row.
        currentValidation = revalidate(working, input.entityModel);

        const result = {
          ok: fixed > 0,
          matched: matching.length,
          attempted: targets.length,
          fixed,
          byApplied,
          firstErrors,
          totalFailures: currentValidation.failures.length,
        };
        await trace(
          "bulkDeterministicFix",
          { table, column, constraint },
          result,
          result.ok,
        );
        return result;
      },
    }),

    finish: tool({
      description:
        "Signal that repair is complete. Call this when totalFailures is 0 or no further progress is possible. Include a one-line reason.",
      inputSchema: z.object({
        reason: z.string().min(1),
      }),
      execute: async ({ reason }) => {
        const result = {
          acknowledged: true,
          totalFailures: currentValidation.failures.length,
          reason,
        };
        await trace("finish", { reason }, result, true);
        return result;
      },
    }),
  };

  // Short-circuit: nothing to do.
  if (input.initialFailures.length === 0) {
    return {
      dataset: working,
      validation: currentValidation,
      toolCalls,
      stoppedReason: "no-failures",
    };
  }

  const initialSummary = summariseFailures(input.initialFailures);
  const userPrompt = [
    `Product context:`,
    input.productContext.trim(),
    "",
    `Schema (table → columns with constraints):`,
    describeModelTerse(input.entityModel),
    "",
    `Initial failures: ${input.initialFailures.length}`,
    `By constraint: ${JSON.stringify(initialSummary.byConstraint)}`,
    `By table: ${JSON.stringify(initialSummary.byTable)}`,
    "",
    `Sample failures (call listFailures for the full set):`,
    JSON.stringify(input.initialFailures.slice(0, 12).map(failureShape), null, 2),
    "",
    `Repair them. Call finish when done.`,
  ].join("\n");

  try {
    const generation = await generateText({
      model: input.llmModel,
      system: AGENT_SYSTEM,
      prompt: userPrompt,
      tools,
      stopWhen: [stepCountIs(input.stepCap ?? 20), hasToolCall("finish")],
    });
    const stopped = finishedExplicitly(generation) ? "finish" : "step-cap";
    return {
      dataset: working,
      validation: currentValidation,
      toolCalls,
      stoppedReason: stopped,
    };
  } catch (err) {
    return {
      dataset: working,
      validation: currentValidation,
      toolCalls,
      stoppedReason: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function revalidate(
  dataset: RawDataset,
  model: EntityModel,
): ValidationReport {
  const canonical = toCanonical(dataset, model);
  return validateDataset(canonical, model);
}

function deepCloneDataset(d: RawDataset): RawDataset {
  const out: RawDataset = {};
  for (const [t, rows] of Object.entries(d)) {
    out[t] = rows.map((r) => ({ ...r }) as RawRow);
  }
  return out;
}

function uniqueScalars(values: readonly unknown[]): ScalarLiteral[] {
  const seen = new Set<string>();
  const out: ScalarLiteral[] = [];
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const k = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v as ScalarLiteral);
  }
  return out;
}

function collectUsedTuples(
  rows: readonly RawRow[],
  cols: readonly string[],
): Set<string> {
  const used = new Set<string>();
  for (const r of rows) {
    if (cols.some((c) => r[c] === null || r[c] === undefined)) continue;
    used.add(
      cols
        .map((c) => {
          const v = r[c];
          return typeof v === "object" ? JSON.stringify(v) : String(v);
        })
        .join("␟"),
    );
  }
  return used;
}

function enumerateUnused(
  pools: readonly ScalarLiteral[][],
  used: Set<string>,
  limit: number,
): ScalarLiteral[][] {
  const out: ScalarLiteral[][] = [];
  const dims = pools.length;
  const indices = new Array<number>(dims).fill(0);
  while (out.length < limit) {
    const tuple = indices.map((i, d) => pools[d]![i]!);
    const key = tuple
      .map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)))
      .join("␟");
    if (!used.has(key)) out.push(tuple);
    // Increment with carry.
    let d = dims - 1;
    while (d >= 0) {
      indices[d]!++;
      if (indices[d]! < pools[d]!.length) break;
      indices[d] = 0;
      d--;
    }
    if (d < 0) break;
  }
  return out;
}

function failureShape(f: ConstraintFailure): Record<string, unknown> {
  return {
    table: f.table,
    rowIndex: f.rowIndex,
    column: f.column ?? null,
    constraint: f.constraint,
    detail: f.detail,
  };
}

function summariseFailures(failures: readonly ConstraintFailure[]): {
  byConstraint: Record<string, number>;
  byTable: Record<string, number>;
} {
  const byConstraint: Record<string, number> = {};
  const byTable: Record<string, number> = {};
  for (const f of failures) {
    byConstraint[f.constraint] = (byConstraint[f.constraint] ?? 0) + 1;
    byTable[f.table] = (byTable[f.table] ?? 0) + 1;
  }
  return { byConstraint, byTable };
}

function describeModelTerse(model: EntityModel): string {
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
          if (c.enumValues && c.enumValues.length > 0)
            bits.push(`enum[${c.enumValues.join(",")}]`);
          return `${c.name}(${bits.join(",")})`;
        })
        .join(", ");
      const compositeUniques = (t.uniqueConstraints ?? [])
        .filter((u) => u.columns.length > 1)
        .map((u) => `unique(${u.columns.join(",")})`);
      const composite = compositeUniques.length > 0
        ? `; ${compositeUniques.join(", ")}`
        : "";
      return `  ${t.name}: ${cols}${composite}`;
    })
    .join("\n");
}

function finishedExplicitly(generation: { toolCalls?: unknown[] }): boolean {
  const calls = generation.toolCalls ?? [];
  for (const c of calls) {
    if (
      typeof c === "object" &&
      c !== null &&
      "toolName" in c &&
      (c as { toolName: string }).toolName === "finish"
    ) {
      return true;
    }
  }
  return false;
}
