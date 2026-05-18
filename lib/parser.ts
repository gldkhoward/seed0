/**
 * Task 2.1 + 2.2: parse Postgres DDL (accepted subset) into the shared
 * EntityModel contract defined in @/lib/types. Triggers, functions,
 * partitioning, custom domains, table inheritance, and similar
 * constructs are rejected with an error naming the construct (D2).
 *
 * The parser is intentionally text-shape preserving on CHECK constraints
 * (the raw `check` string is retained on Column / Table), but when a
 * column-level check has the form `<column> IN (<literals>)` the
 * literal set is lifted to `Column.enumValues` so the constraint
 * validator can deterministically reject out-of-set values (D2's
 * "ENUM/text with check" surface).
 */

import {
  parse,
  toSql,
  type Statement,
  type CreateTableStatement,
  type CreateEnumType,
  type CreateColumnDef,
  type CreateColumnsLikeTable,
  type DataTypeDef,
  type Expr,
  type ColumnConstraint,
  type TableConstraint,
} from "pgsql-ast-parser";

import type { Column, ColumnType, EntityModel, Table } from "./types";

export class UnsupportedConstructError extends Error {
  readonly construct: string;
  constructor(construct: string, detail?: string) {
    super(
      `Unsupported Postgres construct: ${construct}${detail ? ` (${detail})` : ""}`,
    );
    this.name = "UnsupportedConstructError";
    this.construct = construct;
  }
}

export class SchemaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaParseError";
  }
}

const ALLOWED_STATEMENT_TYPES = new Set<string>([
  "create table",
  "create enum",
  "create schema",
  "create index",
  "comment",
  "begin",
  "commit",
  "rollback",
  "start transaction",
  "tablespace",
  "set",
  "set timezone",
  "set names",
]);

const REJECTED_WITH_NAME: Record<string, string> = {
  "create function": "function",
  "create trigger": "trigger",
  "create view": "view",
  "create materialized view": "materialized view",
  "create domain": "custom domain",
  "create rule": "rule",
  "create policy": "row-level security policy",
  "create role": "role",
  "create user": "role",
  "create publication": "logical replication",
  "create subscription": "logical replication",
  "alter table": "alter table",
  "alter sequence": "alter sequence",
};

type EnumDef = { name: string; values: readonly string[] };

export function parseSchema(ddl: string): EntityModel {
  let statements: Statement[];
  try {
    statements = parse(ddl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SchemaParseError(`Failed to parse DDL: ${msg}`);
  }

  const enums = new Map<string, EnumDef>();
  const createTables: CreateTableStatement[] = [];

  for (const stmt of statements) {
    const t = stmt.type;
    if (REJECTED_WITH_NAME[t]) {
      throw new UnsupportedConstructError(REJECTED_WITH_NAME[t]);
    }
    if (!ALLOWED_STATEMENT_TYPES.has(t)) {
      throw new UnsupportedConstructError(t);
    }
    if (t === "create enum") {
      const e = stmt as CreateEnumType;
      const def: EnumDef = {
        name: lower(e.name.name),
        values: e.values.map((v) => String(v.value)),
      };
      enums.set(def.name, def);
    } else if (t === "create table") {
      const ct = stmt as CreateTableStatement;
      if (ct.inherits && ct.inherits.length > 0) {
        throw new UnsupportedConstructError(
          "table inheritance",
          `${ct.name.name} inherits from ${ct.inherits.map((q) => q.name).join(", ")}`,
        );
      }
      createTables.push(ct);
    }
  }

  const tables = createTables.map((ct) => buildTable(ct, enums));

  // Validate FK targets exist after all tables are seen.
  const byName = new Map(tables.map((t) => [t.name, t]));
  for (const t of tables) {
    for (const c of t.columns) {
      if (!c.references) continue;
      const target = byName.get(c.references.table);
      if (!target) {
        throw new SchemaParseError(
          `Foreign key on ${t.name}.${c.name} references unknown table ${c.references.table}`,
        );
      }
      if (!target.columns.some((tc) => tc.name === c.references!.column)) {
        throw new SchemaParseError(
          `Foreign key on ${t.name}.${c.name} references unknown column ${c.references.table}.${c.references.column}`,
        );
      }
    }
  }

  return { tables };
}

function buildTable(
  ct: CreateTableStatement,
  enums: Map<string, EnumDef>,
): Table {
  const name = lower(ct.name.name);
  const columns: Column[] = [];
  const tableUniques: Array<{ columns: readonly string[] }> = [];
  const tableChecks: string[] = [];
  let primaryKey: string[] | undefined;

  for (const def of ct.columns) {
    if (isColumnDef(def)) {
      columns.push(buildColumn(name, def, enums));
    } else {
      const like = def as CreateColumnsLikeTable;
      throw new UnsupportedConstructError(
        "LIKE-clause table",
        `${name} uses LIKE ${like.like.name}`,
      );
    }
  }

  for (const c of (ct.constraints ?? []) as TableConstraint[]) {
    if (c.type === "primary key") {
      primaryKey = c.columns.map((n) => lower(n.name));
      for (const colName of primaryKey) {
        const col = columns.find((cc) => cc.name === colName);
        if (col) {
          col.primaryKey = true;
          col.nullable = false;
        }
      }
    } else if (c.type === "unique") {
      tableUniques.push({ columns: c.columns.map((n) => lower(n.name)) });
    } else if (c.type === "foreign key") {
      const local = c.localColumns.map((n) => lower(n.name));
      const foreign = c.foreignColumns.map((n) => lower(n.name));
      if (local.length !== 1 || foreign.length !== 1) {
        throw new UnsupportedConstructError(
          "composite foreign key",
          `${name}(${local.join(",")}) → ${c.foreignTable.name}(${foreign.join(",")})`,
        );
      }
      const col = columns.find((cc) => cc.name === local[0]);
      if (col) {
        col.references = {
          table: lower(c.foreignTable.name),
          column: foreign[0],
        };
      }
    } else if (c.type === "check") {
      tableChecks.push(safeToSql(c.expr));
    }
  }

  const table: Table = {
    name,
    columns,
    ...(primaryKey ? { primaryKey } : {}),
    ...(tableUniques.length ? { uniqueConstraints: tableUniques } : {}),
    ...(tableChecks.length ? { checks: tableChecks } : {}),
  };
  return table;
}

function buildColumn(
  tableName: string,
  def: CreateColumnDef,
  enums: Map<string, EnumDef>,
): Column {
  const name = lower(def.name.name);
  const type = mapType(def.dataType, enums, tableName, name);
  const col: Column = {
    name,
    type,
    nullable: true,
  };
  if (def.dataType.kind !== "array") {
    const enumDef = enums.get(lower(def.dataType.name));
    if (enumDef) col.enumValues = enumDef.values;
  }
  for (const c of (def.constraints ?? []) as ColumnConstraint[]) {
    switch (c.type) {
      case "not null":
        col.nullable = false;
        break;
      case "null":
        col.nullable = true;
        break;
      case "primary key":
        col.primaryKey = true;
        col.nullable = false;
        col.unique = true;
        break;
      case "unique":
        col.unique = true;
        break;
      case "default":
        col.default = safeToSql(c.default);
        break;
      case "check":
        applyColumnCheck(col, c.expr);
        break;
      case "reference":
        if (!c.foreignColumns || c.foreignColumns.length !== 1) {
          throw new UnsupportedConstructError(
            "composite inline reference",
            `${tableName}.${name}`,
          );
        }
        col.references = {
          table: lower(c.foreignTable.name),
          column: lower(c.foreignColumns[0].name),
        };
        break;
      default: {
        const anyC = c as { type?: string };
        if (anyC.type === "add generated") {
          throw new UnsupportedConstructError("generated column", `${tableName}.${name}`);
        }
      }
    }
  }
  return col;
}

function applyColumnCheck(col: Column, expr: Expr): void {
  const lifted = tryLiftInCheck(expr, col.name);
  if (lifted) {
    col.enumValues = lifted;
    return;
  }
  col.check = safeToSql(expr);
}

/**
 * If `expr` is `<col> IN (<literal>, ...)` for the given column, return the
 * literal values as strings. Otherwise return undefined. We accept either
 * the pgsql-ast-parser `binary` IN representation or a chain of equality
 * comparisons.
 */
function tryLiftInCheck(expr: Expr, column: string): readonly string[] | undefined {
  if (expr.type === "binary" && expr.op === "IN") {
    if (
      expr.left.type === "ref" &&
      lower(expr.left.name) === column &&
      (expr.right.type === "list" || expr.right.type === "array")
    ) {
      const values: string[] = [];
      for (const e of expr.right.expressions) {
        if (e.type === "string") values.push(e.value);
        else if (e.type === "integer" || e.type === "numeric") values.push(String(e.value));
        else if (e.type === "boolean") values.push(String(e.value));
        else return undefined;
      }
      return values;
    }
  }
  return undefined;
}

function mapType(
  dt: DataTypeDef,
  enums: Map<string, EnumDef>,
  tableName: string,
  columnName: string,
): ColumnType {
  if (dt.kind === "array") {
    throw new UnsupportedConstructError(
      "array column type",
      `${tableName}.${columnName}`,
    );
  }
  const raw = lower(dt.name);
  // User-declared enums are surfaced as 'text' on the contract; their
  // values are attached to Column.enumValues for the validator.
  if (enums.has(raw)) return "text";
  switch (raw) {
    case "int":
    case "int4":
    case "integer":
      return "integer";
    case "int8":
    case "bigint":
      return "bigint";
    case "int2":
    case "smallint":
      // No "smallint" member in the contract — fold into integer.
      return "integer";
    case "serial":
    case "smallserial":
      return "integer";
    case "bigserial":
      return "bigint";
    case "text":
    case "citext":
      return "text";
    case "varchar":
    case "character varying":
    case "char":
    case "character":
      return "character varying";
    case "bool":
    case "boolean":
      return "boolean";
    case "timestamp":
    case "timestamp without time zone":
      return "timestamp";
    case "timestamptz":
    case "timestamp with time zone":
      return "timestamp with time zone";
    case "date":
      return "date";
    case "numeric":
    case "decimal":
    case "real":
    case "float4":
    case "double precision":
    case "float8":
      return "numeric";
    case "uuid":
      return "uuid";
    case "json":
      return "json";
    case "jsonb":
      return "jsonb";
    default:
      throw new UnsupportedConstructError(
        "column type",
        `${tableName}.${columnName} has type ${raw}`,
      );
  }
}

function isColumnDef(
  d: CreateColumnDef | CreateColumnsLikeTable,
): d is CreateColumnDef {
  return d.kind === "column";
}

function lower(s: string): string {
  return s.toLowerCase();
}

function safeToSql(expr: Expr): string {
  try {
    const fn = toSql.expr;
    if (typeof fn === "function") return String(fn(expr));
  } catch {
    /* fall through */
  }
  return `<${expr.type}>`;
}
