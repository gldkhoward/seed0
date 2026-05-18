/**
 * Shared types: the contract between pipeline agents.
 *
 * These types are the boundary between the demo fixture + eval (Section C)
 * and the pipeline implementation. Nothing in lib/fixtures or lib/eval
 * imports from anywhere except this module, so the fixture and regression
 * runner stay compilable while pipeline agents fill in the rest.
 */

export type ScalarLiteral = string | number | boolean | null;

export type ColumnType =
  | "integer"
  | "bigint"
  | "text"
  | "character varying"
  | "boolean"
  | "timestamp"
  | "timestamp with time zone"
  | "date"
  | "numeric"
  | "uuid"
  | "json"
  | "jsonb";

export type Column = {
  name: string;
  type: ColumnType;
  nullable: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  enumValues?: readonly string[];
  check?: string;
  references?: { table: string; column: string };
  default?: string;
};

export type Table = {
  name: string;
  columns: readonly Column[];
  /**
   * Composite primary key. Omit when the primary key is a single column
   * already flagged with `primaryKey: true` on that column.
   */
  primaryKey?: readonly string[];
  /**
   * Multi-column UNIQUE constraints. Single-column uniques are expressed
   * via `Column.unique: true`.
   */
  uniqueConstraints?: ReadonlyArray<{ columns: readonly string[] }>;
  /**
   * Table-level CHECK constraints (raw SQL text). Column-level CHECKs
   * live on `Column.check`.
   */
  checks?: readonly string[];
};

export type EntityModel = {
  tables: readonly Table[];
};

/**
 * D11 predicate algebra.
 *
 * A predicate targets a single table; it is satisfied by a row when the
 * `where` expression evaluates true for that row. A scenario is
 * "instantiated" if at least one row in `predicate.table` satisfies it.
 *
 * Free text and raw SQL are intentionally not part of this shape — the
 * predicate is structurally typed so the deterministic evaluator can run
 * without invoking the model.
 */
export type PredicateExpr =
  | { kind: "and"; clauses: readonly PredicateExpr[] }
  | { kind: "or"; clauses: readonly PredicateExpr[] }
  | { kind: "not"; clause: PredicateExpr }
  | { kind: "eq"; column: string; value: ScalarLiteral }
  | { kind: "neq"; column: string; value: ScalarLiteral }
  | { kind: "gt"; column: string; value: number | string }
  | { kind: "gte"; column: string; value: number | string }
  | { kind: "lt"; column: string; value: number | string }
  | { kind: "lte"; column: string; value: number | string }
  | { kind: "in"; column: string; values: readonly ScalarLiteral[] }
  | { kind: "isNull"; column: string }
  | { kind: "isNotNull"; column: string };

export type Predicate = {
  table: string;
  where: PredicateExpr;
};

export type Scenario = {
  id: string;
  name: string;
  description: string;
  predicate: Predicate;
};

export type ScenarioPlan = {
  scenarios: readonly Scenario[];
};

/**
 * Canonical dataset (D10): JSON keyed by table, deterministic value
 * serialization, tables ordered topologically by FK dependency.
 */
export type CanonicalDataset = {
  tables: Readonly<Record<string, ReadonlyArray<Record<string, ScalarLiteral>>>>;
  tableOrder: readonly string[];
};

export type ConstraintKind =
  | "not_null"
  | "foreign_key"
  | "enum"
  | "check"
  | "unique"
  | "type";

export type ConstraintFailure = {
  table: string;
  rowIndex: number;
  column?: string;
  constraint: ConstraintKind;
  detail: string;
};

export type ValidationReport = {
  totalRecords: number;
  passingRecords: number;
  passRate: number;
  failures: readonly ConstraintFailure[];
};

export type ScenarioEvaluation = {
  scenarioId: string;
  instantiated: boolean;
  matchedRowCount: number;
};

export type ReadinessReport = {
  constraintPassRate: number;
  predicateCoverage: number;
  scenarioResults: readonly ScenarioEvaluation[];
  validation: ValidationReport;
};

/**
 * Pipeline contract. The regression runner depends on these function
 * shapes — not on any concrete implementation. Pipeline agents must
 * export an object satisfying this interface.
 */
export interface Pipeline {
  parse(ddl: string): EntityModel;
  generate(input: {
    entityModel: EntityModel;
    context: string;
    plan: ScenarioPlan;
    volume: number;
  }): Promise<CanonicalDataset>;
  validate(input: {
    entityModel: EntityModel;
    dataset: CanonicalDataset;
  }): ValidationReport;
  evaluatePredicates(input: {
    plan: ScenarioPlan;
    dataset: CanonicalDataset;
  }): readonly ScenarioEvaluation[];
  score(input: {
    plan: ScenarioPlan;
    validation: ValidationReport;
    evaluations: readonly ScenarioEvaluation[];
  }): ReadinessReport;
}
