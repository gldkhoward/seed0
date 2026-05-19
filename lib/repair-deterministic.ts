/**
 * Deterministic repair helpers — pure functions that know how to fix
 * the failure classes the LLM provably cannot fix on its own:
 *
 *   - Composite-unique on junction tables (e.g. book_author): the model
 *     has no way to know which (title_id, author_id) pairs are already
 *     used. We enumerate the cartesian product of valid parent IDs and
 *     slot in a fresh pair.
 *   - Single-column unique: fresh value from the column's type domain.
 *   - Foreign-key violation: substitute a valid parent ID from the
 *     current dataset.
 *   - NOT NULL on a nullable-fillable column: type-appropriate default.
 *
 * Used by the agent's `deterministicFix` tool. The agent is free to
 * call it on any (table, rowIndex) and the helper looks at the row's
 * outstanding failures to decide what to apply.
 */

import { createHash } from "node:crypto";

import type { RawDataset, RawRow } from "./shape-validate";
import type {
  ColumnType,
  ConstraintFailure,
  EntityModel,
  ScalarLiteral,
  Table,
} from "./types";

export interface DeterministicFixResult {
  ok: boolean;
  applied?:
    | "composite-unique"
    | "single-unique"
    | "foreign-key"
    | "not-null"
    | "noop";
  detail: string;
}

interface FixContext {
  model: EntityModel;
  dataset: RawDataset;
  failures: readonly ConstraintFailure[];
}

export function attemptDeterministicFix(
  ctx: FixContext,
  table: string,
  rowIndex: number,
): DeterministicFixResult {
  const tableDef = ctx.model.tables.find((t) => t.name === table);
  if (!tableDef) {
    return { ok: false, detail: `unknown table ${table}` };
  }
  const rows = ctx.dataset[table] ?? [];
  const row = rows[rowIndex];
  if (!row) {
    return { ok: false, detail: `row ${table}[${rowIndex}] not present` };
  }
  const onRow = ctx.failures.filter(
    (f) => f.table === table && f.rowIndex === rowIndex,
  );
  if (onRow.length === 0) {
    return { ok: true, applied: "noop", detail: "no failures on this row" };
  }

  // Priority order: composite-unique → single-unique → FK → NOT NULL.
  // Earlier fixes can resolve later ones (e.g. replacing the FK part of
  // a composite key naturally clears the FK violation too).
  const compositeUnique = onRow.find(
    (f) => f.constraint === "unique" && f.column && f.column.includes(","),
  );
  if (compositeUnique) {
    return fixCompositeUnique(ctx, tableDef, rowIndex, compositeUnique);
  }
  const singleUnique = onRow.find((f) => f.constraint === "unique");
  if (singleUnique) {
    return fixSingleUnique(ctx, tableDef, rowIndex, singleUnique);
  }
  const fk = onRow.find((f) => f.constraint === "foreign_key");
  if (fk) {
    return fixForeignKey(ctx, tableDef, rowIndex, fk);
  }
  const notNull = onRow.find((f) => f.constraint === "not_null");
  if (notNull) {
    return fixNotNull(ctx, tableDef, rowIndex, notNull);
  }
  return {
    ok: false,
    detail: `no deterministic strategy for ${onRow[0]!.constraint}`,
  };
}

// ---------------------------------------------------------------------
// Composite-unique on FK columns (the junction-table case)
// ---------------------------------------------------------------------

function fixCompositeUnique(
  ctx: FixContext,
  table: Table,
  rowIndex: number,
  failure: ConstraintFailure,
): DeterministicFixResult {
  const cols = (failure.column ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  if (cols.length < 2) {
    return { ok: false, detail: "composite-unique failure missing columns" };
  }

  // Build parent-value pools for each column. If a column is an FK, use
  // the current values of the parent's referenced column; otherwise
  // collect values currently present in this column across the table.
  const pools: ScalarLiteral[][] = cols.map((colName) => {
    const col = table.columns.find((c) => c.name === colName);
    if (col?.references) {
      const parentRows =
        ctx.dataset[col.references.table] ?? ([] as RawRow[]);
      const seen = new Set<string>();
      const out: ScalarLiteral[] = [];
      for (const pr of parentRows) {
        const v = pr[col.references.column];
        if (v === null || v === undefined) continue;
        const k = scalarKey(v);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(v as ScalarLiteral);
        }
      }
      return out;
    }
    // Non-FK column — sample currently-used values as a domain hint.
    const tableRows = ctx.dataset[table.name] ?? [];
    const seen = new Set<string>();
    const out: ScalarLiteral[] = [];
    for (const r of tableRows) {
      const v = r[colName];
      if (v === null || v === undefined) continue;
      const k = scalarKey(v);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(v as ScalarLiteral);
      }
    }
    return out;
  });

  if (pools.some((p) => p.length === 0)) {
    return {
      ok: false,
      detail: `at least one column has no candidate values: ${cols.join(", ")}`,
    };
  }

  const used = collectUsedTuples(ctx.dataset[table.name] ?? [], cols, rowIndex);
  const pair = pickUnusedTuple(pools, used);
  if (!pair) {
    return {
      ok: false,
      detail: `no unused (${cols.join(", ")}) combinations remain — table is at full coverage`,
    };
  }

  const row = ctx.dataset[table.name]![rowIndex]!;
  for (let i = 0; i < cols.length; i++) row[cols[i]!] = pair[i]!;
  return {
    ok: true,
    applied: "composite-unique",
    detail: `assigned (${cols.join(", ")}) = (${pair.map((v) => JSON.stringify(v)).join(", ")})`,
  };
}

function collectUsedTuples(
  rows: readonly RawRow[],
  cols: readonly string[],
  excludeRowIndex: number,
): Set<string> {
  const used = new Set<string>();
  rows.forEach((r, i) => {
    if (i === excludeRowIndex) return;
    if (cols.some((c) => r[c] === null || r[c] === undefined)) return;
    used.add(cols.map((c) => scalarKey(r[c])).join("␟"));
  });
  return used;
}

function pickUnusedTuple(
  pools: readonly ScalarLiteral[][],
  used: Set<string>,
): ScalarLiteral[] | null {
  // Bounded cartesian walk — typical junction tables top out at a few
  // hundred combinations. Stop on first miss.
  const dims = pools.length;
  const indices = new Array<number>(dims).fill(0);
  while (true) {
    const tuple = indices.map((i, d) => pools[d]![i]!);
    const key = tuple.map((v) => scalarKey(v)).join("␟");
    if (!used.has(key)) return tuple;
    // Increment with carry.
    let d = dims - 1;
    while (d >= 0) {
      indices[d]!++;
      if (indices[d]! < pools[d]!.length) break;
      indices[d] = 0;
      d--;
    }
    if (d < 0) return null;
  }
}

// ---------------------------------------------------------------------
// Single-column unique
// ---------------------------------------------------------------------

function fixSingleUnique(
  ctx: FixContext,
  table: Table,
  rowIndex: number,
  failure: ConstraintFailure,
): DeterministicFixResult {
  const colName = failure.column ?? "";
  const col = table.columns.find((c) => c.name === colName);
  if (!col) {
    return { ok: false, detail: `column ${colName} not on table` };
  }
  const rows = ctx.dataset[table.name] ?? [];
  const used = new Set<string>();
  rows.forEach((r, i) => {
    if (i === rowIndex) return;
    const v = r[colName];
    if (v !== null && v !== undefined) used.add(scalarKey(v));
  });

  // FK-aware path: when the column is itself a foreign key, "fresh" is
  // not freedom to mint values — it has to be a value that exists in
  // the parent table. Otherwise we trade a UNIQUE violation for an FK
  // violation and the agent loops forever. If the parent pool is
  // exhausted (every parent ID is already used in this column), fall
  // through to the composite-unique branch where the caller has more
  // context, or fail cleanly.
  if (col.references) {
    const parentRows =
      ctx.dataset[col.references.table] ?? ([] as RawRow[]);
    for (const pr of parentRows) {
      const v = pr[col.references.column];
      if (v === null || v === undefined) continue;
      if (used.has(scalarKey(v))) continue;
      ctx.dataset[table.name]![rowIndex]![colName] = v as ScalarLiteral;
      return {
        ok: true,
        applied: "single-unique",
        detail: `${colName} = ${JSON.stringify(v)} (from ${col.references.table}.${col.references.column} pool)`,
      };
    }
    return {
      ok: false,
      detail: `${colName} is an FK to ${col.references.table}.${col.references.column} but every parent value is already in use here — likely an over-allocation; column may need composite-unique fix instead`,
    };
  }

  const fresh = freshValueForType(col.type, colName, table.name, used);
  if (fresh === undefined) {
    return {
      ok: false,
      detail: `cannot mint a fresh value for ${col.type} column`,
    };
  }
  ctx.dataset[table.name]![rowIndex]![colName] = fresh;
  return {
    ok: true,
    applied: "single-unique",
    detail: `${colName} = ${JSON.stringify(fresh)}`,
  };
}

function freshValueForType(
  type: ColumnType,
  colName: string,
  tableName: string,
  used: Set<string>,
): ScalarLiteral | undefined {
  if (type === "integer" || type === "bigint") {
    // Find smallest positive integer not in used.
    for (let n = 1; n < 1_000_000; n++) {
      if (!used.has(String(n))) return n;
    }
    return undefined;
  }
  if (type === "uuid") {
    // Deterministic UUIDs derived from seed; bump suffix until unused.
    for (let i = 0; i < 1_000_000; i++) {
      const u = deterministicUuid(`${tableName}::${colName}::repair::${i}`);
      if (!used.has(u)) return u;
    }
    return undefined;
  }
  if (type === "text" || type === "character varying") {
    for (let i = 0; i < 1_000_000; i++) {
      const s = `${tableName}-${colName}-${i}`;
      if (!used.has(s)) return s;
    }
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------
// Foreign key
// ---------------------------------------------------------------------

function fixForeignKey(
  ctx: FixContext,
  table: Table,
  rowIndex: number,
  failure: ConstraintFailure,
): DeterministicFixResult {
  const colName = failure.column ?? "";
  const col = table.columns.find((c) => c.name === colName);
  if (!col?.references) {
    return { ok: false, detail: `column ${colName} not an FK on ${table.name}` };
  }
  const parentRows = ctx.dataset[col.references.table] ?? [];
  const valid = parentRows
    .map((r) => r[col.references!.column])
    .filter((v): v is ScalarLiteral => v !== null && v !== undefined);
  if (valid.length === 0) {
    return {
      ok: false,
      detail: `parent table ${col.references.table} has no rows`,
    };
  }
  // Pick deterministically by hashing the offending row index — so
  // re-running the same repair gives the same outcome.
  const idx = stableIndex(`${table.name}.${colName}::${rowIndex}`, valid.length);
  ctx.dataset[table.name]![rowIndex]![colName] = valid[idx]!;
  return {
    ok: true,
    applied: "foreign-key",
    detail: `${colName} → ${col.references.table}.${col.references.column} = ${JSON.stringify(valid[idx])}`,
  };
}

// ---------------------------------------------------------------------
// NOT NULL
// ---------------------------------------------------------------------

function fixNotNull(
  ctx: FixContext,
  table: Table,
  rowIndex: number,
  failure: ConstraintFailure,
): DeterministicFixResult {
  const colName = failure.column ?? "";
  const col = table.columns.find((c) => c.name === colName);
  if (!col) {
    return { ok: false, detail: `column ${colName} not on table` };
  }
  if (col.enumValues && col.enumValues.length > 0) {
    ctx.dataset[table.name]![rowIndex]![colName] = col.enumValues[0]!;
    return {
      ok: true,
      applied: "not-null",
      detail: `${colName} = ${JSON.stringify(col.enumValues[0])}`,
    };
  }
  const dflt = typeDefault(col.type, table.name, colName, rowIndex);
  if (dflt === undefined) {
    return { ok: false, detail: `no default available for ${col.type}` };
  }
  ctx.dataset[table.name]![rowIndex]![colName] = dflt;
  return {
    ok: true,
    applied: "not-null",
    detail: `${colName} = ${JSON.stringify(dflt)}`,
  };
}

function typeDefault(
  type: ColumnType,
  tableName: string,
  colName: string,
  rowIndex: number,
): ScalarLiteral | undefined {
  switch (type) {
    case "integer":
    case "bigint":
      return 0;
    case "numeric":
      return "0";
    case "boolean":
      return false;
    case "text":
    case "character varying":
      return `${colName}-${rowIndex}`;
    case "uuid":
      return deterministicUuid(`${tableName}::${colName}::default::${rowIndex}`);
    case "timestamp":
    case "timestamp with time zone":
      return new Date(0).toISOString();
    case "date":
      return "1970-01-01";
    case "json":
    case "jsonb":
      return "{}";
  }
}

// ---------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------

function scalarKey(v: unknown): string {
  if (v === null || v === undefined) return " null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function stableIndex(seed: string, modulo: number): number {
  if (modulo <= 0) return 0;
  const hex = createHash("md5").update(seed).digest("hex");
  // Use first 8 hex chars → 32-bit unsigned; mod into pool length.
  return parseInt(hex.slice(0, 8), 16) % modulo;
}

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
