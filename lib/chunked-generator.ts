/**
 * Chunked, FK-aware seed generator.
 *
 * The single-call generator (lib/generator.ts) hits the model's
 * output-token ceiling around ~300-600 rows depending on schema
 * width. We generate one table per LLM call, with three critical
 * optimizations:
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
 *   3. **All tables in parallel.** Because PKs are pre-allocated for
 *      every table before any LLM call fires, FK pools are known
 *      upfront — child tables don't need parent tables to *finish*,
 *      only to *exist on the allocation map*. Every table's LLM call
 *      runs concurrently via Promise.all, no FK staging gates. For
 *      typical 8–10 table schemas this is the dominant wall-clock
 *      win (previously 2–3 sequential rounds → now 1).
 *
 * The result is shape-compatible with the single-call generator's
 * output: a `Record<string, Record<string, unknown>[]>` keyed by
 * table name. The workflow's existing shape-validate + constraint
 * validate + repair pipeline runs on the assembled dataset unchanged.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

import { structuredOutput } from "./ai";
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
  /**
   * Architect-authored row allocations. When provided, bypasses the
   * built-in `allocateRows` heuristic. Keys must be table names from
   * `entityModel`; missing tables fall back to a small per-table
   * baseline so FK pools are never empty.
   */
  externalAllocations?: Record<string, number>;
  /**
   * Architect-authored parallel waves. When provided, generation runs
   * wave-by-wave (`for (wave of waves) await Promise.all(wave)`)
   * instead of all tables concurrently. Tables not listed in any wave
   * are added to the final wave so coverage is guaranteed.
   */
  externalParallelGroups?: readonly (readonly string[])[];
}

export type ChunkedProgressEvent =
  | {
      kind: "start";
      allocations: Record<string, number>;
      autoAllocatedKeys: Record<string, string>;
      tableCount: number;
    }
  | {
      kind: "table-complete";
      table: string;
      rowCount: number;
    };

export interface ChunkedGenerateResult {
  rows: Record<string, Record<string, unknown>[]>;
  allocations: Record<string, number>;
}

export async function chunkedGenerate(
  input: ChunkedGenerateInput,
): Promise<ChunkedGenerateResult> {
  const { entityModel, plan, volume, productContext, llmModel, onProgress } =
    input;

  const tablesByName = new Map(entityModel.tables.map((t) => [t.name, t]));
  const tableNames = entityModel.tables.map((t) => t.name);
  const allocations = input.externalAllocations
    ? normalizeExternalAllocations(input.externalAllocations, tableNames)
    : allocateRows(entityModel, plan, volume);
  const waves = input.externalParallelGroups
    ? normalizeWaves(input.externalParallelGroups, tableNames)
    : [tableNames];

  // Pre-allocate EVERY single-column UNIQUE (PK + non-PK uniques) with
  // a deterministically-allocatable type. Two payoffs:
  //   1. Child tables' FK pools are ready before any LLM call fires,
  //      so the whole schema generates in one parallel round.
  //   2. The model never has to invent unique TEXT/UUID/INT values
  //      across sub-chunks running in parallel — those would otherwise
  //      collide on every shared sequence (e.g. tracking_number-0,
  //      tracking_number-1, ...) and produce thousands of UNIQUE
  //      violations downstream.
  //
  // `primaryKeys` (kept as a Map<table, ScalarLiteral[]>) holds just
  // the PK values, since FK pool construction targets the PK column.
  // `preAllocByTable` carries the FULL set of pre-allocated values
  // per (table, column) so we can both tell the model to omit those
  // columns and merge the values back in afterwards.
  const primaryKeys = new Map<string, ScalarLiteral[]>();
  const preAllocByTable = new Map<string, Record<string, ScalarLiteral[]>>();
  const autoAllocatedKeys: Record<string, string> = {};
  for (const tableName of tableNames) {
    const table = tablesByName.get(tableName)!;
    const count = allocations[tableName] ?? 0;
    const cols = pickAutoAllocatableUniques(table);
    const perTable: Record<string, ScalarLiteral[]> = {};
    for (const col of cols) {
      perTable[col.name] = allocateUniqueValues(col, tableName, count);
    }
    preAllocByTable.set(tableName, perTable);
    const pkCol = cols.find((c) => c.primaryKey);
    if (pkCol) {
      primaryKeys.set(tableName, perTable[pkCol.name] ?? []);
    } else {
      primaryKeys.set(tableName, []);
    }
    if (cols.length > 0) {
      autoAllocatedKeys[tableName] = cols
        .map((c) => `${c.name} (${c.type})`)
        .join(", ");
    }
  }

  if (onProgress) {
    await onProgress({
      kind: "start",
      allocations,
      autoAllocatedKeys,
      tableCount: tableNames.length,
    });
  }

  const generatedRows: Record<string, Record<string, unknown>[]> = {};
  for (const tableName of tableNames) generatedRows[tableName] = [];

  // Run wave-by-wave so the architect's parallelism plan is honored.
  // Within a wave all tables run concurrently; PKs are pre-allocated
  // across the whole schema, so cross-wave FK pools are valid before
  // any wave fires.
  for (const wave of waves) {
    await Promise.all(
      wave.map(async (tableName) => {
        const table = tablesByName.get(tableName);
        if (!table) return;
        const count = allocations[tableName] ?? 0;
        if (count === 0) return;

        const preAlloc = preAllocByTable.get(tableName) ?? {};
        const skipColumns = Object.keys(preAlloc);
        const fkPools = buildFkPools(table, primaryKeys);
        const scenarios = plan.scenarios.filter(
          (s) => s.predicate.table === tableName,
        );

        const llmRows = await generateForTable({
          table,
          count,
          skipColumns,
          fkPools,
          scenarios,
          productContext,
          llmModel,
        });

        const finalRows = mergePreAllocated(table, preAlloc, llmRows);
        generatedRows[tableName] = finalRows;

        if (onProgress) {
          await onProgress({
            kind: "table-complete",
            table: tableName,
            rowCount: finalRows.length,
          });
        }
      }),
    );
  }

  return { rows: generatedRows, allocations };
}

/**
 * Coerce an architect-supplied allocation map into a complete one.
 * Tables present in the model but missing from the input get a
 * 3-row baseline so child tables always have a non-empty FK pool.
 */
function normalizeExternalAllocations(
  external: Record<string, number>,
  modelTables: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  const MIN_PER_TABLE = 3;
  for (const t of modelTables) {
    const v = external[t];
    out[t] =
      typeof v === "number" && Number.isFinite(v) && v >= 0
        ? Math.max(MIN_PER_TABLE, Math.floor(v))
        : MIN_PER_TABLE;
  }
  return out;
}

/**
 * Coerce architect-supplied parallel waves into a complete schedule.
 * Tables missing from the schedule are appended as a trailing wave so
 * the workflow always produces rows for every table in the model.
 */
function normalizeWaves(
  external: readonly (readonly string[])[],
  modelTables: readonly string[],
): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const wave of external) {
    const filtered: string[] = [];
    for (const t of wave) {
      if (modelTables.includes(t) && !seen.has(t)) {
        filtered.push(t);
        seen.add(t);
      }
    }
    if (filtered.length > 0) out.push(filtered);
  }
  const missing = modelTables.filter((t) => !seen.has(t));
  if (missing.length > 0) out.push(missing);
  return out;
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
// Deterministic key allocation
// ---------------------------------------------------------------------

export function pickAutoAllocatablePk(table: Table): Column | null {
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

/**
 * All single-column UNIQUE columns we can deterministically pre-fill —
 * the PK if its type is allocatable, plus every non-PK single-column
 * UNIQUE on a text/integer/bigint/uuid column. Composite uniques
 * (`Table.uniqueConstraints`) are NOT included; they still go through
 * the model and rely on bulk repair for any collisions.
 */
export function pickAutoAllocatableUniques(table: Table): Column[] {
  const cols: Column[] = [];
  // PK first so its index is 0 in callers iterating in order.
  const pk = pickAutoAllocatablePk(table);
  if (pk) cols.push(pk);
  for (const c of table.columns) {
    if (c.primaryKey) continue; // already handled above
    if (!c.unique) continue;
    if (!isAllocatableUniqueType(c.type)) continue;
    cols.push(c);
  }
  return cols;
}

function isAllocatableUniqueType(type: Column["type"]): boolean {
  return (
    type === "integer" ||
    type === "bigint" ||
    type === "uuid" ||
    type === "text" ||
    type === "character varying"
  );
}

/**
 * Allocate `count` deterministic, distinct values for a single-column
 * UNIQUE constraint. PK columns route through the existing
 * `allocateKeys` (sequential ints, hash-derived UUIDs). Non-PK
 * uniques use seeded patterns that mirror the deterministic-repair
 * fallback (`<table>-<col>-<i>` for text, sequential for ints) so the
 * shape is identical to what repair would have produced — except now
 * it's done up-front and there's nothing to repair.
 */
export function allocateUniqueValues(
  col: Column,
  tableName: string,
  count: number,
): ScalarLiteral[] {
  if (col.primaryKey) {
    return allocateKeys(col, tableName, count);
  }
  const out: ScalarLiteral[] = [];
  if (col.type === "integer" || col.type === "bigint") {
    // Offset by a large constant so non-PK unique ints don't collide
    // with PK sequences (which start at 1). Unique TEXT/UUID columns
    // don't have this risk because their domains are disjoint.
    const offset = 1_000_000;
    for (let i = 0; i < count; i++) out.push(offset + i + 1);
    return out;
  }
  if (col.type === "uuid") {
    for (let i = 0; i < count; i++) {
      out.push(deterministicUuid(`${tableName}::${col.name}::unique::${i}`));
    }
    return out;
  }
  if (col.type === "text" || col.type === "character varying") {
    for (let i = 0; i < count; i++) {
      out.push(`${tableName}-${col.name}-${i}`);
    }
    return out;
  }
  return out;
}

export function allocateKeys(
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
// FK pools
// ---------------------------------------------------------------------

export function buildFkPools(
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

// ---------------------------------------------------------------------
// Per-table generation
// ---------------------------------------------------------------------

/**
 * Maximum rows to ask the model for in a single per-table LLM call.
 * Above this the response JSON gets long enough that either:
 *   - structured-output parsing fails (the model truncates on the
 *     output-token ceiling, producing unclosed JSON), or
 *   - the model's coherence degrades and it starts repeating rows.
 * When `count` exceeds this we split into sub-chunks and concatenate
 * the results. PK pre-allocation happens at the chunked-generator
 * level, so splitting is transparent to the caller.
 */
const MAX_ROWS_PER_CALL = 80;

export async function generateForTable(params: {
  table: Table;
  count: number;
  skipColumns: readonly string[];
  fkPools: Record<string, ScalarLiteral[]>;
  scenarios: readonly Scenario[];
  productContext: string;
  llmModel: string;
}): Promise<Record<string, unknown>[]> {
  const { count } = params;
  if (count <= 0) return [];
  if (count <= MAX_ROWS_PER_CALL) {
    return generateChunk(params, count);
  }

  // Split into roughly-equal sub-chunks of <= MAX_ROWS_PER_CALL each.
  // Bounded concurrency per table so we don't blow AI Gateway rate
  // limits on huge tables (sibling tables in the same wave also run
  // in parallel, so unbounded fan-out compounds quickly).
  const chunks = splitCount(count, MAX_ROWS_PER_CALL);
  const results = await runWithConcurrency(
    chunks,
    SUB_CHUNK_CONCURRENCY,
    (chunkCount) => generateChunk(params, chunkCount),
  );
  return results.flat();
}

const SUB_CHUNK_CONCURRENCY = 3;

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return results;
}

function splitCount(total: number, maxPerChunk: number): number[] {
  const out: number[] = [];
  let remaining = total;
  while (remaining > 0) {
    const next = Math.min(maxPerChunk, remaining);
    out.push(next);
    remaining -= next;
  }
  return out;
}

/**
 * One LLM call producing `count` rows. Retries once with half the row
 * count on `AI_NoObjectGeneratedError` (the SDK's parse-failure
 * signal), since those failures are almost always model output
 * truncation — a smaller ask fits inside the output budget.
 */
async function generateChunk(
  params: {
    table: Table;
    skipColumns: readonly string[];
    fkPools: Record<string, ScalarLiteral[]>;
    scenarios: readonly Scenario[];
    productContext: string;
    llmModel: string;
  },
  count: number,
): Promise<Record<string, unknown>[]> {
  const {
    table,
    skipColumns,
    fkPools,
    scenarios,
    productContext,
    llmModel,
  } = params;

  const skipSet = new Set(skipColumns);
  const generableCols = table.columns.filter((c) => !skipSet.has(c.name));

  const system = [
    `You generate seed data for a single Postgres table.`,
    `Return a JSON array of exactly ${count} row object(s) — no prose, no Markdown.`,
    skipColumns.length > 0
      ? `The following columns are pre-assigned by the system and MUST be omitted from your output: ${skipColumns.join(", ")}.`
      : `Generate every required column, ensuring uniqueness.`,
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
    productContext,
  });

  const rowSchema = buildRowSchema(generableCols);
  const schema = z
    .array(rowSchema)
    .min(1)
    .max(Math.max(count * 2, count + 5));

  const maxOutputTokens = Math.min(32_768, count * 250 + 2_048);

  try {
    const { object } = await structuredOutput({
      model: llmModel,
      schema,
      system,
      prompt,
      maxOutputTokens,
    });
    return (object as Record<string, unknown>[]).slice(0, count);
  } catch (err) {
    // Output-truncation parse failures are recoverable by asking for
    // fewer rows. Re-throw any other class of error.
    if (!isObjectParseError(err) || count <= 4) throw err;
    const half = Math.max(4, Math.floor(count / 2));
    const rest = count - half;
    const first = await generateChunk(params, half);
    if (rest <= 0) return first;
    const second = await generateChunk(params, rest);
    return first.concat(second);
  }
}

function isObjectParseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  if (e.name === "AI_NoObjectGeneratedError") return true;
  if (typeof e.message === "string" && e.message.includes("could not parse"))
    return true;
  return false;
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
  productContext: string;
}): string {
  const {
    table,
    generableCols,
    count,
    fkPools,
    scenarios,
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

export function mergePrimaryKeys(
  table: Table,
  pks: readonly ScalarLiteral[],
  llmRows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  // Back-compat shim: same semantics as the previous single-PK merge.
  // New code paths should use `mergePreAllocated` instead.
  if (pks.length === 0) return llmRows.map((r) => ({ ...r }));
  const pkCol = table.columns.find((c) => c.primaryKey);
  if (!pkCol) return llmRows.map((r) => ({ ...r }));
  return mergePreAllocated(table, { [pkCol.name]: [...pks] }, llmRows);
}

/**
 * Merge pre-allocated values for one OR MORE columns back into the
 * LLM's rows. Each entry in `preAlloc` is a column name plus its
 * deterministic sequence; the i-th row gets the i-th value from every
 * sequence. Order in the output is preserved.
 *
 * If the model returns fewer rows than were allocated, we keep only
 * `min(allocated, generated)` rows — so an undershooting call doesn't
 * leave phantom rows holding pre-allocated unique values without any
 * accompanying scenario data.
 */
export function mergePreAllocated(
  _table: Table,
  preAlloc: Record<string, readonly ScalarLiteral[]>,
  llmRows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const cols = Object.keys(preAlloc);
  if (cols.length === 0) return llmRows.map((r) => ({ ...r }));
  const allocatedLen = Math.min(
    ...cols.map((c) => preAlloc[c]!.length),
  );
  const len = Math.min(allocatedLen, llmRows.length);
  const merged: Record<string, unknown>[] = [];
  for (let i = 0; i < len; i++) {
    const row: Record<string, unknown> = { ...llmRows[i] };
    for (const c of cols) {
      row[c] = preAlloc[c]![i]!;
    }
    merged.push(row);
  }
  return merged;
}
