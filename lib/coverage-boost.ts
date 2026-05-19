/**
 * Coverage-boost: targeted regeneration for uninstantiated scenarios.
 *
 * Runs only when the architect enabled `optionalSteps: ["coverage-boost"]`
 * AND `predicate-evaluate` reports missing scenarios. For each table
 * that anchors at least one missing scenario, we ask the model to
 * produce additional rows specifically designed to satisfy those
 * predicates, then merge them into the dataset.
 *
 * We reuse `generateForTable` from chunked-generator with the same
 * pre-allocated unique-column / FK pool plumbing — the only difference
 * is that the prompt is restricted to the missing-scenario list, and
 * pre-allocated sequences continue from where the original generation
 * left off so they don't collide with the first batch.
 */

import { createHash } from "node:crypto";

import {
  buildFkPools,
  generateForTable,
  mergePreAllocated,
  pickAutoAllocatablePk,
  pickAutoAllocatableUniques,
} from "./chunked-generator";
import type {
  Column,
  EntityModel,
  ScalarLiteral,
  Scenario,
  ScenarioPlan,
} from "./types";

export interface CoverageBoostInput {
  entityModel: EntityModel;
  plan: ScenarioPlan;
  productContext: string;
  llmModel: string;
  /** Mutable raw dataset; new rows are appended. */
  dataset: Record<string, Record<string, unknown>[]>;
  /** Scenario ids that did not instantiate in the first pass. */
  missingScenarioIds: readonly string[];
  /** Additional rows to add per affected table. */
  rowsPerTable?: number;
}

export interface CoverageBoostResult {
  perTable: Array<{
    table: string;
    addedRows: number;
    scenarioIds: readonly string[];
  }>;
  totalAddedRows: number;
}

export async function runCoverageBoost(
  input: CoverageBoostInput,
): Promise<CoverageBoostResult> {
  const rowsPerTable = input.rowsPerTable ?? 4;
  const tablesByName = new Map(
    input.entityModel.tables.map((t) => [t.name, t]),
  );
  const missingSet = new Set(input.missingScenarioIds);
  const missingByTable = new Map<string, Scenario[]>();
  for (const s of input.plan.scenarios) {
    if (!missingSet.has(s.id)) continue;
    const arr = missingByTable.get(s.predicate.table) ?? [];
    arr.push(s);
    missingByTable.set(s.predicate.table, arr);
  }

  // Existing PK values across the whole dataset become the FK pools for
  // any newly generated rows on child tables.
  const primaryKeys = new Map<string, ScalarLiteral[]>();
  for (const [tableName, rows] of Object.entries(input.dataset)) {
    const table = tablesByName.get(tableName);
    if (!table) continue;
    const pk = pickAutoAllocatablePk(table);
    if (!pk) {
      primaryKeys.set(tableName, []);
      continue;
    }
    const values: ScalarLiteral[] = [];
    for (const row of rows) {
      const v = row[pk.name];
      if (v !== undefined && v !== null) values.push(v as ScalarLiteral);
    }
    primaryKeys.set(tableName, values);
  }

  const perTable: CoverageBoostResult["perTable"] = [];

  // Process tables sequentially so each table's new rows can serve as
  // FK pools for the next. Same-table generation is one LLM call.
  for (const [tableName, scenarios] of missingByTable) {
    const table = tablesByName.get(tableName);
    if (!table) continue;

    // Pre-allocate fresh, non-colliding values for EVERY auto-unique
    // column (PK + non-PK uniques). Offsets are based on the current
    // count of existing values so new sequences don't overlap.
    const uniqueCols = pickAutoAllocatableUniques(table);
    const existingByCol: Record<string, Set<string>> = {};
    for (const col of uniqueCols) {
      const used = new Set<string>();
      for (const row of input.dataset[tableName] ?? []) {
        const v = row[col.name];
        if (v !== null && v !== undefined) used.add(scalarKey(v));
      }
      existingByCol[col.name] = used;
    }
    const preAlloc: Record<string, ScalarLiteral[]> = {};
    for (const col of uniqueCols) {
      preAlloc[col.name] = continueUniqueAllocation(
        col,
        tableName,
        existingByCol[col.name]!,
        rowsPerTable,
      );
    }
    const fkPools = buildFkPools(table, primaryKeys);

    const llmRows = await generateForTable({
      table,
      count: rowsPerTable,
      skipColumns: Object.keys(preAlloc),
      fkPools,
      scenarios,
      productContext: input.productContext,
      llmModel: input.llmModel,
    });
    const finalRows = mergePreAllocated(table, preAlloc, llmRows);

    // Append into the dataset and update the PK pool so subsequent
    // tables in this same boost pass see the new IDs.
    input.dataset[tableName] = [
      ...(input.dataset[tableName] ?? []),
      ...finalRows,
    ];
    const pk = uniqueCols.find((c) => c.primaryKey);
    if (pk) {
      const existing = primaryKeys.get(tableName) ?? [];
      primaryKeys.set(tableName, [
        ...existing,
        ...finalRows
          .map((r) => r[pk.name])
          .filter((v) => v !== undefined && v !== null) as ScalarLiteral[],
      ]);
    }

    perTable.push({
      table: tableName,
      addedRows: finalRows.length,
      scenarioIds: scenarios.map((s) => s.id),
    });
  }

  return {
    perTable,
    totalAddedRows: perTable.reduce((sum, t) => sum + t.addedRows, 0),
  };
}

/**
 * Continue allocation for an auto-unique column past whatever values
 * already exist. Walks the generator's seed sequence and skips any
 * value already present in `existing` — so a boost that adds rows to
 * a table already holding `packages-tracking_number-0..199` will hand
 * out `packages-tracking_number-200`, `packages-tracking_number-201`,
 * etc.
 */
function continueUniqueAllocation(
  col: Column,
  tableName: string,
  existing: Set<string>,
  count: number,
): ScalarLiteral[] {
  const out: ScalarLiteral[] = [];
  let i = 0;
  // Reasonable upper bound to avoid pathological loops.
  const limit = existing.size + count + 50_000;
  while (out.length < count && i < limit) {
    const value = seedValue(col, tableName, i);
    if (value !== undefined && !existing.has(scalarKey(value))) {
      out.push(value);
      existing.add(scalarKey(value));
    }
    i++;
  }
  return out;
}

function seedValue(
  col: Column,
  tableName: string,
  i: number,
): ScalarLiteral | undefined {
  if (col.primaryKey) {
    if (col.type === "integer" || col.type === "bigint") return i + 1;
    if (col.type === "uuid") {
      return deterministicUuid(`${tableName}::${col.name}::${i}`);
    }
    return undefined;
  }
  if (col.type === "integer" || col.type === "bigint") {
    return 1_000_000 + i + 1;
  }
  if (col.type === "uuid") {
    return deterministicUuid(`${tableName}::${col.name}::unique::${i}`);
  }
  if (col.type === "text" || col.type === "character varying") {
    return `${tableName}-${col.name}-${i}`;
  }
  return undefined;
}

function scalarKey(v: unknown): string {
  if (v === null || v === undefined) return " null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// Inline copy of the deterministic UUID generator from chunked-generator
// so this module's boost-time seeds remain identical to those produced
// by the first-pass generator without widening the public surface.
function deterministicUuid(seed: string): string {
  const hex = createHash("md5").update(seed).digest("hex");
  const variantHex = (
    (parseInt(hex.charAt(16), 16) & 0x3) |
    0x8
  ).toString(16);
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `${variantHex}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}
