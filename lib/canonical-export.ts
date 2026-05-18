/**
 * Deterministic serializers for the canonical dataset. JSON is the source
 * of truth; the SQL export is derived from the JSON and never produced by
 * the model. Tables are emitted in `tableOrder` (topological) so the
 * INSERTs respect foreign-key dependency order on a fresh database.
 */

import type { CanonicalDataset, ScalarLiteral } from "@/lib/types";

export function canonicalJson(dataset: CanonicalDataset): string {
  const out: Record<string, ReadonlyArray<Record<string, ScalarLiteral>>> = {};
  for (const table of dataset.tableOrder) {
    const rows = dataset.tables[table] ?? [];
    out[table] = rows.map((row) => {
      const sortedKeys = Object.keys(row).sort();
      const next: Record<string, ScalarLiteral> = {};
      for (const k of sortedKeys) next[k] = row[k];
      return next;
    });
  }
  return JSON.stringify(out, null, 2) + "\n";
}

function sqlLiteral(value: ScalarLiteral): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function ident(name: string): string {
  return /^[a-z_][a-z0-9_]*$/i.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export function canonicalSql(dataset: CanonicalDataset): string {
  const chunks: string[] = [
    "-- seed0 canonical export",
    "-- Derived deterministically from the canonical JSON; not model-generated.",
    "BEGIN;",
    "",
  ];
  for (const table of dataset.tableOrder) {
    const rows = dataset.tables[table] ?? [];
    if (rows.length === 0) {
      chunks.push(`-- ${ident(table)}: no rows`);
      chunks.push("");
      continue;
    }
    const columns = Array.from(
      new Set(rows.flatMap((r) => Object.keys(r))),
    ).sort();
    const columnList = columns.map(ident).join(", ");
    chunks.push(
      `-- ${ident(table)} (${rows.length} row${rows.length === 1 ? "" : "s"})`,
    );
    chunks.push(`INSERT INTO ${ident(table)} (${columnList}) VALUES`);
    const values = rows.map((row, i) => {
      const literal =
        "  (" + columns.map((c) => sqlLiteral(row[c] ?? null)).join(", ") + ")";
      return literal + (i === rows.length - 1 ? ";" : ",");
    });
    chunks.push(values.join("\n"));
    chunks.push("");
  }
  chunks.push("COMMIT;");
  return chunks.join("\n") + "\n";
}
