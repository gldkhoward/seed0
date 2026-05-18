/**
 * Chunked, FK-aware seed generator.
 *
 * The single-call generator (lib/generator.ts) hits the model's
 * output-token ceiling around ~300-600 rows depending on schema
 * width. To produce production-realistic volumes (2K-10K rows) we
 * generate one table at a time, in FK-topological order, with three
 * critical optimizations:
 *
 *   1. **Deterministic primary keys.** For tables with a single
 *      integer/bigint/uuid PK, we pre-allocate the PK values before
 *      calling the model — sequential ints, or hash-derived UUIDs.
 *      The model is told to OMIT the PK column from its output; we
 *      merge our pre-allocated values in afterwards. This eliminates
 *      PK uniqueness failures entirely and shrinks the per-row token
 *      cost.
 *
 *   2. **Explicit FK value pools.** When generating a child table,
 *      each FK column is given the exact list of valid parent PK
 *      values. The model must pick from the list — it cannot invent
 *      new IDs. This eliminates the entire FK-violation failure class.
 *
 *   3. **Parallel within FK stages.** Tables with no mutual FK
 *      dependency at the same topological level (e.g. `customers`
 *      and `categories`) generate concurrently via Promise.all.
 *      Different stages are sequential because later tables need
 *      earlier tables' PKs.
 *
 * The result is shape-compatible with the single-call generator's
 * output: a `Record<string, Record<string, unknown>[]>` keyed by
 * table name. The workflow's existing shape-validate + constraint
 * validate + repair pipeline runs on the assembled dataset unchanged.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

import { structuredOutput } from "./ai";
import { topologicalOrder } from "./canonical";
import type {
  Column,
  ColumnType,
  EntityModel,
  ScalarLiteral,
  Scenario,
  ScenarioPlan,
  Table,
} from "./types";

// ---------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------

export interface ChunkedGenerateInput {
  entityModel: EntityModel;
  plan: ScenarioPlan;
  /** Total target rows across all tables. Allocated proportionally. */
  volume: number;
  productContext: string;
  llmModel: string;
  /**
   * Progress callback. Fired with a `start` event once the allocation
   * and stages are decided, and a `table-complete` event each time a
   * per-table generation finishes. Use it to write live progress into
   * the run-store so the UI can render incremental state.
   */
  onProgress?: (event: ChunkedProgressEvent) => Promise<void> | void;
}

export type ChunkedProgressEvent =
  | {
      kind: "start";
      allocations: Record<string, number>;
      stages: readonly (readonly string[])[];
      autoAllocatedKeys: Record<string, string>;
    }
  | {
      kind: "table-complete";
      table: string;
      rowCount: number;
      stage: number;
    };

export interface ChunkedGenerateResult {
  rows: Record<string, Record<string, unknown>[]>;
  allocations: Record<string, number>;
  stages: readonly (readonly string[])[];
}

export async function chunkedGenerate(
  input: ChunkedGenerateInput,
): Promise<ChunkedGenerateResult> {
  const { entityModel, plan, volume, productContext, llmModel, onProgress } =
    input;

  const tablesByName = new Map(entityModel.tables.map((t) => [t.name, t]));
  const order = topologicalOrder(entityModel);
  const allocations = allocateRows(entityModel, plan, volume);
  const stages = computeStages(entityModel, order);

  // Pre-allocate PKs for every table that has an auto-allocatable single PK.
  const primaryKeys = new Map<string, ScalarLiteral[]>();
  const autoAllocatedKeys: Record<string, string> = {};
  for (const tableName of order) {
    const table = tablesByName.get(tableName)!;
    const count = allocations[tableName] ?? 0;
    const pk = pickAutoAllocatablePk(table);
    if (pk) {
      primaryKeys.set(tableName, allocateKeys(pk, tableName, count));
      autoAllocatedKeys[tableName] = `${pk.name} (${pk.type})`;
    } else {
      primaryKeys.set(tableName, []);
    }
  }

  if (onProgress) {
    await onProgress({
      kind: "start",
      allocations,
      stages,
      autoAllocatedKeys,
    });
  }

  const generatedRows: Record<string, Record<string, unknown>[]> = {};
  for (const tableName of order) generatedRows[tableName] = [];

  // Walk stages sequentially; parallelize within a stage.
  for (let stageIdx = 0; stageIdx < stages.length; stageIdx++) {
    const stage = stages[stageIdx]!;
    await Promise.all(
      stage.map(async (tableName) => {
        const table = tablesByName.get(tableName)!;
        const count = allocations[tableName] ?? 0;
        if (count === 0) return;

        const pks = primaryKeys.get(tableName) ?? [];
        const skipPkColumn = pks.length > 0;
        const fkPools = buildFkPools(table, primaryKeys);
        const scenarios = plan.scenarios.filter(
          (s) => s.predicate.table === tableName,
        );
        const parentSample = sampleParentRows(table, generatedRows);

        const llmRows = await generateForTable({
          table,
          count,
          skipPkColumn,
          fkPools,
          scenarios,
          parentSample,
          productContext,
          llmModel,
        });

        const finalRows = mergePrimaryKeys(table, pks, llmRows);
        generatedRows[tableName] = finalRows;

        if (onProgress) {
          await onProgress({
            kind: "table-complete",
            table: tableName,
            rowCount: finalRows.length,
            stage: stageIdx,
          });
        }
      }),
    );
  }

  return { rows: generatedRows, allocations, stages };
}

// ---------------------------------------------------------------------
// Row allocation: distribute requested volume across tables
// ---------------------------------------------------------------------

/**
 * Distribute `volume` rows across the model's tables. Tables that
 * appear in more scenarios get a proportional bump (more scenarios →
 * more variety needed → more rows). Every table gets at least 3 rows
 * so single-row guard cases aren't pathological.
 */
function allocateRows(
  model: EntityModel,
  plan: ScenarioPlan,
  volume: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (model.tables.length === 0) return out;

  const MIN_PER_TABLE = 3;
  const baseline = 1;
  const scenarioBonus = 0.75;

  const scores: Record<string, number> = {};
  for (const t of model.tables) scores[t.name] = baseline;
  for (const s of plan.scenarios) {
    scores[s.predicate.table] =
      (scores[s.predicate.table] ?? baseline) + scenarioBonus;
  }
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);

  // Reserve minimum per table first.
  const minTotal = MIN_PER_TABLE * model.tables.length;
  const remaining = Math.max(0, volume - minTotal);

  let allocated = 0;
  for (const t of model.tables) {
    const proportion = (scores[t.name] ?? baseline) / totalScore;
    const extra = Math.floor(remaining * proportion);
    out[t.name] = MIN_PER_TABLE + extra;
    allocated += out[t.name];
  }

  // Distribute any rounding shortfall/overshoot.
  const sorted = [...model.tables].sort(
    (a, b) => (scores[b.name] ?? 0) - (scores[a.name] ?? 0),
  );
  let diff = volume - allocated;
  let cursor = 0;
  while (diff !== 0 && sorted.length > 0) {
    const t = sorted[cursor % sorted.length]!;
    if (diff > 0) {
      out[t.name] += 1;
      diff -= 1;
    } else if (out[t.name] > MIN_PER_TABLE) {
      out[t.name] -= 1;
      diff += 1;
    }
    cursor += 1;
    // Safety bail: if we walked the whole list with nothing to give back, stop.
    if (cursor > sorted.length * 4) break;
  }
  return out;
}

// ---------------------------------------------------------------------
// Stages: parallel-safe groupings of the FK topological order
// ---------------------------------------------------------------------

function computeStages(
  model: EntityModel,
  order: readonly string[],
): readonly (readonly string[])[] {
  // For each table, the set of tables it depends on (excluding self-refs).
  const deps = new Map<string, Set<string>>();
  for (const t of model.tables) {
    const set = new Set<string>();
    for (const c of t.columns) {
      if (c.references && c.references.table !== t.name) {
        if (model.tables.some((other) => other.name === c.references!.table)) {
          set.add(c.references.table);
        }
      }
    }
    deps.set(t.name, set);
  }

  const placed = new Set<string>();
  const stages: string[][] = [];
  const remaining = new Set(order);

  while (remaining.size > 0) {
    const stage: string[] = [];
    for (const t of order) {
      if (!remaining.has(t)) continue;
      const d = deps.get(t) ?? new Set();
      const satisfied = [...d].every((parent) => placed.has(parent));
      if (satisfied) stage.push(t);
    }
    if (stage.length === 0) {
      // Cycle: emit remaining as one final stage in topological order.
      stages.push([...remaining]);
      break;
    }
    for (const t of stage) {
      placed.add(t);
      remaining.delete(t);
    }
    stages.push(stage);
  }

  return stages;
}

// ---------------------------------------------------------------------
// Deterministic key allocation
// ---------------------------------------------------------------------

function pickAutoAllocatablePk(table: Table): Column | null {
  const pkCols = table.columns.filter((c) => c.primaryKey);
  if (pkCols.length !== 1) return null; // composite PK → let model handle
  const pk = pkCols[0]!;
  if (
    pk.type === "integer" ||
    pk.type === "bigint" ||
    pk.type === "uuid"
  ) {
    return pk;
  }
  return null;
}

function allocateKeys(
  pk: Column,
  tableName: string,
  count: number,
): ScalarLiteral[] {
  const out: ScalarLiteral[] = [];
  for (let i = 0; i < count; i++) {
    if (pk.type === "integer" || pk.type === "bigint") {
      out.push(i + 1);
    } else if (pk.type === "uuid") {
      out.push(deterministicUuid(`${tableName}::${pk.name}::${i}`));
    }
  }
  return out;
}

/**
 * Deterministic UUID v4-shaped string derived from a seed. Same seed
 * always yields the same UUID, so re-running with the same schema and
 * volume gives identical IDs — handy for cache keys (§6) and for
 * users diffing successive runs.
 */
function deterministicUuid(seed: string): string {
  const hex = createHash("md5").update(seed).digest("hex");
  // 8-4-4-4-12 with version 4 marker + variant bits
  const variantHex = (
    (parseInt(hex.charAt(16), 16) & 0x3) |
    0x8
  ).toString(16);
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `${variantHex}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}

// ---------------------------------------------------------------------
// FK pools + parent samples
// ---------------------------------------------------------------------

function buildFkPools(
  table: Table,
  primaryKeys: Map<string, ScalarLiteral[]>,
): Record<string, ScalarLiteral[]> {
  const pools: Record<string, ScalarLiteral[]> = {};
  for (const col of table.columns) {
    if (!col.references) continue;
    const parentPks = primaryKeys.get(col.references.table);
    if (parentPks && parentPks.length > 0) {
      pools[col.name] = parentPks;
    }
  }
  return pools;
}

function sampleParentRows(
  table: Table,
  generatedRows: Record<string, Record<string, unknown>[]>,
  sampleSize = 5,
): Record<string, Record<string, unknown>[]> {
  const samples: Record<string, Record<string, unknown>[]> = {};
  const fkTables = new Set<string>();
  for (const col of table.columns) {
    if (col.references) fkTables.add(col.references.table);
  }
  for (const fkTable of fkTables) {
    const rows = generatedRows[fkTable] ?? [];
    if (rows.length === 0) continue;
    samples[fkTable] = rows.slice(0, Math.min(sampleSize, rows.length));
  }
  return samples;
}

// ---------------------------------------------------------------------
// Per-table generation
// ---------------------------------------------------------------------

async function generateForTable(params: {
  table: Table;
  count: number;
  skipPkColumn: boolean;
  fkPools: Record<string, ScalarLiteral[]>;
  scenarios: readonly Scenario[];
  parentSample: Record<string, Record<string, unknown>[]>;
  productContext: string;
  llmModel: string;
}): Promise<Record<string, unknown>[]> {
  const {
    table,
    count,
    skipPkColumn,
    fkPools,
    scenarios,
    parentSample,
    productContext,
    llmModel,
  } = params;

  const generableCols = table.columns.filter(
    (c) => !(skipPkColumn && c.primaryKey),
  );

  const system = [
    `You generate seed data for a single Postgres table.`,
    `Return a JSON array of exactly ${count} row object(s) — no prose, no Markdown.`,
    skipPkColumn
      ? `The primary key is pre-assigned and MUST be omitted from your output.`
      : `Generate every required column including the primary key, ensuring uniqueness.`,
    `Foreign-key columns MUST use only values from the provided "Valid values" pools. Do not invent IDs.`,
    `Every row MUST include every listed column — do not omit fields. Nullable columns may take the value null.`,
    `Respect NOT NULL, enum value sets, CHECK constraints. Use ISO-8601 strings for timestamps and dates.`,
  ].join("\n");

  const prompt = buildTablePrompt({
    table,
    generableCols,
    count,
    fkPools,
    scenarios,
    parentSample,
    productContext,
  });

  // Per-table Zod object schema — REQUIRES every column to be present in
  // every row, with column-type-appropriate validators. This is the
  // binding contract AI SDK enforces on the model's response, so the
  // model cannot return rows missing required fields.
  const rowSchema = buildRowSchema(generableCols);
  const schema = z
    .array(rowSchema)
    .min(1)
    .max(Math.max(count * 2, count + 5));

  // Dynamic token budget: ~250 tokens/row + 2K overhead, capped at 32K.
  // Per-row cost is a touch higher now that every column is required.
  const maxOutputTokens = Math.min(32_768, count * 250 + 2_048);

  const { object } = await structuredOutput({
    model: llmModel,
    schema,
    system,
    prompt,
    maxOutputTokens,
  });

  return (object as Record<string, unknown>[]).slice(0, count);
}

/**
 * Build a Zod object schema whose keys are exactly the generable
 * columns, typed appropriately per column. This is what makes the
 * "model returned rows with only FK fields" failure mode impossible:
 * AI SDK enforces the schema on the response, so missing keys fail
 * validation and the SDK re-prompts the model.
 *
 * Type mapping is intentionally permissive on numerics (allows
 * stringified decimals to preserve precision) and timestamps (allows
 * any string — the canonical pass coerces).
 */
function buildRowSchema(cols: readonly Column[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const c of cols) {
    shape[c.name] = makeColumnSchema(c);
  }
  return z.object(shape);
}

function makeColumnSchema(col: Column): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  if (col.enumValues && col.enumValues.length > 0) {
    base = z.enum([...col.enumValues] as [string, ...string[]]);
  } else {
    base = columnTypeToZod(col.type);
  }
  return col.nullable ? base.nullable() : base;
}

function columnTypeToZod(type: ColumnType): z.ZodTypeAny {
  switch (type) {
    case "integer":
    case "bigint":
      // Allow string for bigints that exceed JS number precision.
      return z.union([z.number(), z.string()]);
    case "numeric":
      // Decimals are commonly serialized as strings to preserve precision.
      return z.union([z.number(), z.string()]);
    case "boolean":
      return z.boolean();
    case "text":
    case "character varying":
    case "uuid":
    case "timestamp":
    case "timestamp with time zone":
    case "date":
      return z.string();
    case "json":
    case "jsonb":
      // JSON columns can carry any structure.
      return z.unknown();
  }
}

function buildTablePrompt(params: {
  table: Table;
  generableCols: readonly Column[];
  count: number;
  fkPools: Record<string, ScalarLiteral[]>;
  scenarios: readonly Scenario[];
  parentSample: Record<string, Record<string, unknown>[]>;
  productContext: string;
}): string {
  const {
    table,
    generableCols,
    count,
    fkPools,
    scenarios,
    parentSample,
    productContext,
  } = params;

  const parts: string[] = [];
  parts.push(`Product context:`);
  parts.push(productContext.trim());
  parts.push("");
  parts.push(`Table: ${table.name}`);
  parts.push(`Generate exactly ${count} row(s).`);
  parts.push("");
  parts.push(`Columns to generate (return ONLY these keys per row):`);
  for (const c of generableCols) {
    const bits: string[] = [c.type];
    if (!c.nullable) bits.push("not null");
    if (c.unique) bits.push("unique");
    if (c.enumValues && c.enumValues.length > 0) {
      bits.push(`enum=[${c.enumValues.join("|")}]`);
    }
    if (c.check) bits.push(`check=${c.check}`);
    if (c.references) {
      bits.push(`FK → ${c.references.table}.${c.references.column}`);
    }
    parts.push(`  - ${c.name} (${bits.join(", ")})`);
  }
  parts.push("");

  if (Object.keys(fkPools).length > 0) {
    parts.push(
      `Valid foreign-key values — your output MUST pick from these pools:`,
    );
    for (const [col, vals] of Object.entries(fkPools)) {
      const preview = vals.slice(0, 50);
      const more = vals.length > 50 ? ` ... (${vals.length} total available)` : "";
      parts.push(
        `  - ${col}: [${preview.map((v) => JSON.stringify(v)).join(", ")}]${more}`,
      );
    }
    parts.push("");
  }

  if (Object.keys(parentSample).length > 0) {
    parts.push(
      `Parent row samples (so your rows correlate naturally — e.g. matching FKs to the right parent personalities):`,
    );
    for (const [parentTable, rows] of Object.entries(parentSample)) {
      parts.push(`  ${parentTable}:`);
      for (const row of rows) {
        parts.push(`    ${JSON.stringify(row)}`);
      }
    }
    parts.push("");
  }

  if (scenarios.length > 0) {
    parts.push(
      `Scenarios that MUST be satisfied by at least one row in this table:`,
    );
    for (const s of scenarios) {
      parts.push(`  - ${s.id} — ${s.name}`);
      parts.push(`    ${s.description}`);
      parts.push(`    predicate: ${JSON.stringify(s.predicate.where)}`);
    }
    parts.push("");
  }

  parts.push(`Return a JSON array of exactly ${count} row object(s).`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------
// Merge pre-allocated PKs back into LLM rows
// ---------------------------------------------------------------------

function mergePrimaryKeys(
  table: Table,
  pks: readonly ScalarLiteral[],
  llmRows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  if (pks.length === 0) {
    // Composite PK or text PK: return rows as the model produced them.
    return llmRows.map((r) => ({ ...r }));
  }
  const pkCol = table.columns.find((c) => c.primaryKey);
  if (!pkCol) return llmRows.map((r) => ({ ...r }));
  // Use min(pks, llmRows) so an undershooting model doesn't get phantom rows.
  const len = Math.min(pks.length, llmRows.length);
  const merged: Record<string, unknown>[] = [];
  for (let i = 0; i < len; i++) {
    merged.push({ [pkCol.name]: pks[i], ...llmRows[i] });
  }
  return merged;
}
