/**
 * Task 2.9: canonical dataset assembly (D10).
 *
 * Builds a CanonicalDataset (the contract type from @/lib/types) from
 * deterministically-typed raw rows. The two responsibilities here:
 *
 *   1. Coerce raw values to ScalarLiteral with deterministic
 *      serialization rules (ISO-8601 timestamps, decimals as strings,
 *      explicit nulls).
 *   2. Emit `tableOrder` in topological FK-dependency order so callers
 *      that consume the dataset directly (export to SQL, append-only
 *      cache scale-up) can iterate FK-safely.
 *
 * The structural-shape validator (lib/shape-validate.ts) is the gate
 * that runs *before* this; this module assumes inputs already have
 * known tables and columns. Values that do not coerce to a sensible
 * ScalarLiteral pass through as `null` — the constraint validator then
 * rejects the row with a clear `type` failure.
 */

import type { Column, EntityModel, ScalarLiteral, Table } from "./types";
import type { RawDataset, RawRow } from "./shape-validate";
import type { CanonicalDataset } from "./types";

export function topologicalOrder(model: EntityModel): readonly string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of model.tables) {
    indegree.set(t.name, 0);
    dependents.set(t.name, []);
  }
  for (const t of model.tables) {
    for (const c of t.columns) {
      if (!c.references) continue;
      const target = c.references.table;
      if (target === t.name) continue; // self-reference is allowed
      if (!indegree.has(target)) continue;
      indegree.set(t.name, (indegree.get(t.name) ?? 0) + 1);
      dependents.get(target)!.push(t.name);
    }
  }

  // Stable topological sort over alphabetical order so identical
  // models yield identical sequences (cache-key friendliness).
  const ready = [...indegree.keys()]
    .filter((k) => (indegree.get(k) ?? 0) === 0)
    .sort();
  const out: string[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    out.push(next);
    for (const dep of dependents.get(next) ?? []) {
      const d = (indegree.get(dep) ?? 0) - 1;
      indegree.set(dep, d);
      if (d === 0) {
        const idx = sortedInsert(ready, dep);
        ready.splice(idx, 0, dep);
      }
    }
  }
  // Any tables left (FK cycles): append in alphabetical order.
  for (const t of [...indegree.entries()]
    .filter(([_, v]) => v > 0)
    .map(([k]) => k)
    .sort()) {
    out.push(t);
  }
  return out;
}

function sortedInsert(arr: string[], value: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function toCanonical(
  raw: RawDataset,
  model: EntityModel,
): CanonicalDataset {
  const tableOrder = topologicalOrder(model);
  const byName = new Map(model.tables.map((t) => [t.name, t]));
  const tables: Record<string, ReadonlyArray<Record<string, ScalarLiteral>>> = {};
  for (const tableName of tableOrder) {
    const table = byName.get(tableName)!;
    const rows = raw[tableName] ?? [];
    tables[tableName] = rows.map((row) => canonicalizeRow(table, row));
  }
  return { tables, tableOrder };
}

function canonicalizeRow(table: Table, row: RawRow): Record<string, ScalarLiteral> {
  const out: Record<string, ScalarLiteral> = {};
  for (const col of table.columns) {
    out[col.name] = canonicalizeValue(col, row[col.name]);
  }
  return out;
}

function canonicalizeValue(col: Column, raw: unknown): ScalarLiteral {
  if (raw === undefined || raw === null) return null;
  switch (col.type) {
    case "timestamp":
    case "timestamp with time zone":
      return coerceTimestamp(raw);
    case "date":
      return coerceDate(raw);
    case "numeric":
      return coerceDecimal(raw);
    case "integer":
    case "bigint":
      return coerceInteger(raw);
    case "boolean":
      return coerceBoolean(raw);
    case "json":
    case "jsonb":
      return coerceJson(raw);
    case "uuid":
    case "text":
    case "character varying":
      return coerceString(raw);
  }
}

function coerceString(raw: unknown): ScalarLiteral {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.stringify(raw);
  } catch {
    return null;
  }
}

function coerceBoolean(raw: unknown): ScalarLiteral {
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Anything else returns null so the constraint validator flags the row
  // as a type failure rather than silently coercing.
  return null;
}

function coerceInteger(raw: unknown): ScalarLiteral {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string" && /^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n)) return n;
    // Out of safe-integer range: keep as the original string so precision
    // is preserved (bigint columns).
    return raw;
  }
  // numeric strings like "1.0" round-trip via Number, but the validator
  // will reject non-integers below.
  if (typeof raw === "number") return raw;
  return null;
}

function coerceDecimal(raw: unknown): ScalarLiteral {
  // Decimals as strings to preserve precision (D10).
  if (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw)) return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n)) return String(n);
  }
  return null;
}

function coerceTimestamp(raw: unknown): ScalarLiteral {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return raw.toISOString();
  }
  if (typeof raw === "string") {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return null;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return new Date(raw).toISOString();
  }
  return null;
}

function coerceDate(raw: unknown): ScalarLiteral {
  if (typeof raw === "string") {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
    if (m) return m[1];
    return null;
  }
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toISOString().slice(0, 10);
  }
  return null;
}

function coerceJson(raw: unknown): ScalarLiteral {
  if (raw === null) return null;
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  try {
    return JSON.stringify(raw, jsonSortKeysReplacer);
  } catch {
    return null;
  }
}

function jsonSortKeysReplacer(_k: string, v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[k] = (v as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return v;
}
