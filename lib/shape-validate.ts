/**
 * Task 2.5: deterministic structural-shape validator (D4).
 *
 * Rejects model output that does not parse into the expected per-table
 * row structure, BEFORE constraint validation runs. This is what feeds
 * the bounded generation-step retry (task 2.8); the validate/repair
 * loop (task 2.7) does not run on output that fails here.
 *
 * The validator is intentionally lenient on *values* (downstream type
 * coercion in canonical.ts handles ISO-8601 strings, decimal strings,
 * etc.), but strict on the *shape*: top-level keys must match known
 * tables, rows must be objects, and row keys must match known columns.
 */

import type { EntityModel } from "./types";

export type RawRow = Record<string, unknown>;
export type RawDataset = Record<string, RawRow[]>;

export type ShapeIssue = { path: string; message: string };

export class StructuralShapeError extends Error {
  readonly issues: readonly ShapeIssue[];
  constructor(issues: readonly ShapeIssue[]) {
    super(
      `Generation output has malformed shape: ${issues
        .map((i) => `${i.path}: ${i.message}`)
        .join("; ")}`,
    );
    this.name = "StructuralShapeError";
    this.issues = issues;
  }
}

export function validateShape(
  candidate: unknown,
  model: EntityModel,
): RawDataset {
  const issues: ShapeIssue[] = [];

  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    issues.push({ path: "<root>", message: "expected JSON object keyed by table name" });
    throw new StructuralShapeError(issues);
  }

  const knownTables = new Map(model.tables.map((t) => [t.name, t]));
  const knownColumns: Record<string, Set<string>> = {};
  for (const t of model.tables) {
    knownColumns[t.name] = new Set(t.columns.map((c) => c.name));
  }

  const out: RawDataset = {};
  for (const t of model.tables) out[t.name] = [];

  for (const [rawTable, rawRows] of Object.entries(candidate)) {
    const tableName = rawTable.toLowerCase();
    if (!knownTables.has(tableName)) {
      issues.push({
        path: rawTable,
        message: `unknown table not present in entity model`,
      });
      continue;
    }
    if (!Array.isArray(rawRows)) {
      issues.push({
        path: rawTable,
        message: `expected array of row objects, got ${typeof rawRows}`,
      });
      continue;
    }
    const normalized: RawRow[] = [];
    rawRows.forEach((row, i) => {
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        issues.push({ path: `${tableName}[${i}]`, message: "row is not an object" });
        return;
      }
      const normalizedRow: RawRow = {};
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
        const col = k.toLowerCase();
        if (!knownColumns[tableName].has(col)) {
          issues.push({
            path: `${tableName}[${i}].${k}`,
            message: `unknown column not present in entity model`,
          });
          continue;
        }
        normalizedRow[col] = v;
      }
      normalized.push(normalizedRow);
    });
    out[tableName] = normalized;
  }

  if (issues.length > 0) throw new StructuralShapeError(issues);
  return out;
}
