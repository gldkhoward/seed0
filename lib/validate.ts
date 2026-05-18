/**
 * Task 2.6: deterministic constraint validator (D1 trust boundary).
 *
 * Consumes a CanonicalDataset (already shape-validated + value-coerced
 * to ScalarLiteral) and produces a ValidationReport. The model is not
 * invoked anywhere in this module.
 *
 * Checks performed, in order, per row:
 *   1. not_null       — every NOT NULL column has a value
 *   2. type           — value is assignable to the declared ColumnType
 *   3. enum           — value is in Column.enumValues (when set)
 *   4. check          — best-effort evaluation of CHECK constraints (the
 *                       constraint is preserved as raw text on the Column /
 *                       Table; we evaluate only the structurally simple
 *                       forms — comparisons, AND/OR/NOT, IS [NOT] NULL —
 *                       and skip anything else, since CHECK arbitrary SQL
 *                       is undecidable without a Postgres execution context).
 *   5. unique         — single-column and composite UNIQUE keys
 *   6. foreign_key    — referenced row exists in target table
 *
 * The first per-row failure for each (table, rowIndex) does NOT short-
 * circuit: we report every failure so the repair loop can see the full
 * picture in a single pass.
 */

import type {
  CanonicalDataset,
  Column,
  ColumnType,
  ConstraintFailure,
  EntityModel,
  ScalarLiteral,
  Table,
  ValidationReport,
} from "./types";

export function validateDataset(
  dataset: CanonicalDataset,
  model: EntityModel,
): ValidationReport {
  const failures: ConstraintFailure[] = [];

  // Build FK lookup tables: target table → target column → set of present values.
  const fkPresence: Record<string, Record<string, Set<string>>> = {};
  for (const table of model.tables) {
    const rowsByTable = dataset.tables[table.name] ?? [];
    fkPresence[table.name] = {};
    for (const col of table.columns) {
      const set = new Set<string>();
      for (const row of rowsByTable) {
        const v = row[col.name];
        if (v !== null && v !== undefined) set.add(scalarKey(v));
      }
      fkPresence[table.name][col.name] = set;
    }
  }

  let totalRecords = 0;
  let passingRecords = 0;

  for (const table of model.tables) {
    const rows = dataset.tables[table.name] ?? [];
    totalRecords += rows.length;

    const uniqueIndex = new Map<string, Set<string>>();
    for (const u of table.uniqueConstraints ?? []) {
      uniqueIndex.set(uniqueKey(u.columns), new Set());
    }
    for (const col of table.columns) {
      if (col.unique && !col.primaryKey) {
        uniqueIndex.set(uniqueKey([col.name]), new Set());
      }
      if (col.primaryKey) {
        uniqueIndex.set(uniqueKey([col.name]), new Set());
      }
    }
    if (table.primaryKey && table.primaryKey.length > 1) {
      uniqueIndex.set(uniqueKey(table.primaryKey), new Set());
    }

    rows.forEach((row, i) => {
      const rowFailures: ConstraintFailure[] = [];

      for (const col of table.columns) {
        rowFailures.push(...checkColumn(table, col, row, i, fkPresence));
      }

      for (const [keyName, seen] of uniqueIndex) {
        const cols = keyName.split("|");
        const composite = cols.map((c) => scalarKey(row[c])).join("␟");
        if (cols.every((c) => row[c] !== null && row[c] !== undefined)) {
          if (seen.has(composite)) {
            rowFailures.push({
              table: table.name,
              rowIndex: i,
              column: cols.join(","),
              constraint: "unique",
              detail: `duplicate value for unique key (${cols.join(", ")})`,
            });
          } else {
            seen.add(composite);
          }
        }
      }

      for (const checkSql of table.checks ?? []) {
        if (!evaluateCheckText(checkSql, row)) {
          rowFailures.push({
            table: table.name,
            rowIndex: i,
            constraint: "check",
            detail: `check failed: ${checkSql}`,
          });
        }
      }

      if (rowFailures.length === 0) passingRecords++;
      else failures.push(...rowFailures);
    });
  }

  const passRate = totalRecords === 0 ? 1 : passingRecords / totalRecords;
  return { totalRecords, passingRecords, passRate, failures };
}

function checkColumn(
  table: Table,
  col: Column,
  row: Readonly<Record<string, ScalarLiteral>>,
  index: number,
  fkPresence: Record<string, Record<string, Set<string>>>,
): ConstraintFailure[] {
  const out: ConstraintFailure[] = [];
  const v = row[col.name];

  if (v === null || v === undefined) {
    if (!col.nullable) {
      out.push({
        table: table.name,
        rowIndex: index,
        column: col.name,
        constraint: "not_null",
        detail: `column ${col.name} is NOT NULL`,
      });
    }
    return out;
  }

  if (!matchesType(v, col.type)) {
    out.push({
      table: table.name,
      rowIndex: index,
      column: col.name,
      constraint: "type",
      detail: `value ${JSON.stringify(v)} is not assignable to ${col.type}`,
    });
    return out;
  }

  if (col.enumValues && !col.enumValues.includes(String(v))) {
    out.push({
      table: table.name,
      rowIndex: index,
      column: col.name,
      constraint: "enum",
      detail: `value ${JSON.stringify(v)} not in {${col.enumValues.join(", ")}}`,
    });
    return out;
  }

  if (col.check && !evaluateCheckText(col.check, row)) {
    out.push({
      table: table.name,
      rowIndex: index,
      column: col.name,
      constraint: "check",
      detail: `check failed: ${col.check}`,
    });
  }

  if (col.references) {
    const target = fkPresence[col.references.table]?.[col.references.column];
    if (!target || !target.has(scalarKey(v))) {
      out.push({
        table: table.name,
        rowIndex: index,
        column: col.name,
        constraint: "foreign_key",
        detail: `${col.name}=${JSON.stringify(v)} not present in ${col.references.table}.${col.references.column}`,
      });
    }
  }

  return out;
}

function matchesType(v: ScalarLiteral, type: ColumnType): boolean {
  switch (type) {
    case "integer":
    case "bigint":
      if (typeof v === "number") return Number.isInteger(v);
      if (typeof v === "string") return /^-?\d+$/.test(v);
      return false;
    case "numeric":
      if (typeof v === "string") return /^-?\d+(\.\d+)?$/.test(v);
      if (typeof v === "number") return Number.isFinite(v);
      return false;
    case "boolean":
      return typeof v === "boolean";
    case "text":
    case "character varying":
      return typeof v === "string";
    case "uuid":
      return typeof v === "string" && UUID_RE.test(v);
    case "timestamp":
    case "timestamp with time zone":
      return typeof v === "string" && !Number.isNaN(Date.parse(v));
    case "date":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
    case "json":
    case "jsonb":
      return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  }
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function scalarKey(v: ScalarLiteral | undefined): string {
  if (v === null || v === undefined) return "\0null";
  if (typeof v === "number") return `n:${v}`;
  if (typeof v === "boolean") return `b:${v}`;
  return `s:${v}`;
}

function uniqueKey(columns: readonly string[]): string {
  return columns.join("|");
}

/**
 * Best-effort textual check evaluation. The check is stored as raw SQL
 * (we deliberately do not re-parse). We support the common shapes:
 *   - `col >= 0`, `col > 0`, `col <= N`, `col < N`, `col = literal`
 *   - `col1 OP col2`
 *   - `col IS NULL` / `col IS NOT NULL`
 *   - `expr AND expr`, `expr OR expr`, `NOT expr`
 * Anything we cannot interpret returns `true` so we do not penalise rows
 * for constraint forms we cannot decide deterministically. The original
 * raw text is still surfaced in failure details when other checks fire,
 * preserving the spec's "specific constraint and field" guarantee.
 */
export function evaluateCheckText(
  rawSql: string,
  row: Readonly<Record<string, ScalarLiteral>>,
): boolean {
  const sql = rawSql.trim();
  return evalSqlClause(sql, row) ?? true;
}

function evalSqlClause(
  sql: string,
  row: Readonly<Record<string, ScalarLiteral>>,
): boolean | undefined {
  const stripped = stripOuterParens(sql);

  // AND / OR splits at the top level only.
  const orParts = splitTopLevel(stripped, /\s+OR\s+/i);
  if (orParts.length > 1) {
    let anyTrue = false;
    let allDecidable = true;
    for (const p of orParts) {
      const r = evalSqlClause(p, row);
      if (r === undefined) allDecidable = false;
      else if (r) anyTrue = true;
    }
    if (anyTrue) return true;
    return allDecidable ? false : undefined;
  }
  const andParts = splitTopLevel(stripped, /\s+AND\s+/i);
  if (andParts.length > 1) {
    let allTrue = true;
    let anyDecidable = false;
    for (const p of andParts) {
      const r = evalSqlClause(p, row);
      if (r === undefined) allTrue = false;
      else {
        anyDecidable = true;
        if (!r) return false;
      }
    }
    return allTrue ? true : anyDecidable ? undefined : undefined;
  }

  if (/^NOT\s+/i.test(stripped)) {
    const r = evalSqlClause(stripped.replace(/^NOT\s+/i, ""), row);
    if (r === undefined) return undefined;
    return !r;
  }

  // IS [NOT] NULL
  const nullMatch = stripped.match(/^(\S+)\s+IS\s+(NOT\s+)?NULL\s*$/i);
  if (nullMatch) {
    const colRaw = nullMatch[1];
    const negated = Boolean(nullMatch[2]);
    const v = row[stripIdent(colRaw)];
    const isNull = v === null || v === undefined;
    return negated ? !isNull : isNull;
  }

  // IN (...): col IN ('a','b','c')
  const inMatch = stripped.match(/^(\S+)\s+IN\s*\((.*)\)\s*$/i);
  if (inMatch) {
    const col = stripIdent(inMatch[1]);
    const literals = splitTopLevel(inMatch[2], /,/);
    const v = row[col];
    if (v === null || v === undefined) return false;
    for (const litRaw of literals) {
      const lit = parseLiteral(litRaw.trim());
      if (lit === undefined) return undefined;
      if (String(v) === String(lit)) return true;
    }
    return false;
  }

  // Comparison: <lhs> <op> <rhs>
  const cmpMatch = stripped.match(
    /^(.+?)\s*(>=|<=|!=|<>|=|>|<)\s*(.+)$/,
  );
  if (cmpMatch) {
    const [, lhsRaw, op, rhsRaw] = cmpMatch;
    const lhs = resolveOperand(lhsRaw.trim(), row);
    const rhs = resolveOperand(rhsRaw.trim(), row);
    if (lhs === undefined || rhs === undefined) return undefined;
    return compareValues(lhs, op, rhs);
  }

  return undefined;
}

function stripOuterParens(s: string): string {
  let t = s.trim();
  while (t.startsWith("(") && t.endsWith(")") && parensBalancedAround(t)) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

function parensBalancedAround(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      i = consumeString(s, i);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0 && i !== s.length - 1) return false;
    }
  }
  return depth === 0;
}

function consumeString(s: string, start: number): number {
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === "'") {
      if (s[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
  return i;
}

function splitTopLevel(s: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "'") {
      i = consumeString(s, i);
      continue;
    }
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    if (depth !== 0) continue;
    const rest = s.slice(i);
    const m = rest.match(separator);
    if (m && m.index === 0) {
      parts.push(s.slice(last, i));
      i += m[0].length - 1;
      last = i + 1;
    }
  }
  parts.push(s.slice(last));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function stripIdent(token: string): string {
  let t = token.trim();
  if (t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  return t.toLowerCase();
}

function resolveOperand(
  token: string,
  row: Readonly<Record<string, ScalarLiteral>>,
): ScalarLiteral | undefined {
  const t = token.trim();
  // String literal
  if (t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === "true";
  if (/^null$/i.test(t)) return null;
  const ident = stripIdent(t);
  if (Object.prototype.hasOwnProperty.call(row, ident)) return row[ident];
  return undefined;
}

function parseLiteral(token: string): ScalarLiteral | undefined {
  const t = token.trim();
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === "true";
  if (/^null$/i.test(t)) return null;
  return undefined;
}

function compareValues(
  lhs: ScalarLiteral,
  op: string,
  rhs: ScalarLiteral,
): boolean {
  if (lhs === null || rhs === null) {
    if (op === "=" || op === "==" || op === "!=" || op === "<>") {
      // Postgres semantics: NULL comparisons are unknown → treat as false
      // for `=`, true for `!=` when only one side is NULL.
      if (lhs === null && rhs === null) return op === "=" || op === "==";
      return op === "!=" || op === "<>";
    }
    return false;
  }
  if (typeof lhs === "number" && typeof rhs === "number") {
    return numericCompare(lhs, rhs, op);
  }
  const ln = Number(lhs);
  const rn = Number(rhs);
  if (Number.isFinite(ln) && Number.isFinite(rn)) {
    return numericCompare(ln, rn, op);
  }
  const ls = String(lhs);
  const rs = String(rhs);
  switch (op) {
    case "=":
    case "==":
      return ls === rs;
    case "!=":
    case "<>":
      return ls !== rs;
    case ">":
      return ls > rs;
    case ">=":
      return ls >= rs;
    case "<":
      return ls < rs;
    case "<=":
      return ls <= rs;
  }
  return false;
}

function numericCompare(l: number, r: number, op: string): boolean {
  switch (op) {
    case "=":
    case "==":
      return l === r;
    case "!=":
    case "<>":
      return l !== r;
    case ">":
      return l > r;
    case ">=":
      return l >= r;
    case "<":
      return l < r;
    case "<=":
      return l <= r;
  }
  return false;
}
