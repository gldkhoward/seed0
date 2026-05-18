/**
 * Task 2.10: deterministic predicate evaluator (D11).
 *
 * The model never self-attests to scenario instantiation. Every scenario
 * carries a `Predicate` (single-table, structured PredicateExpr); here
 * we walk the canonical rows for `predicate.table` and count those that
 * satisfy `predicate.where`. A scenario is instantiated iff that count
 * is at least 1.
 *
 * Predicate columns and tables are bound to the entity model elsewhere
 * (planner-time); this module assumes inputs already validated.
 */

import type {
  CanonicalDataset,
  Predicate,
  PredicateExpr,
  ScalarLiteral,
  Scenario,
  ScenarioEvaluation,
  ScenarioPlan,
} from "./types";

export function evaluateScenario(
  scenario: Scenario,
  dataset: CanonicalDataset,
): ScenarioEvaluation {
  return evaluatePredicate(scenario.id, scenario.predicate, dataset);
}

export function evaluatePlan(
  plan: ScenarioPlan,
  dataset: CanonicalDataset,
): readonly ScenarioEvaluation[] {
  return plan.scenarios.map((s) => evaluateScenario(s, dataset));
}

export function evaluatePredicate(
  scenarioId: string,
  predicate: Predicate,
  dataset: CanonicalDataset,
): ScenarioEvaluation {
  const rows = dataset.tables[predicate.table] ?? [];
  let matchedRowCount = 0;
  for (const row of rows) {
    if (evaluateExpr(predicate.where, row)) matchedRowCount++;
  }
  return {
    scenarioId,
    instantiated: matchedRowCount > 0,
    matchedRowCount,
  };
}

export function evaluateExpr(
  expr: PredicateExpr,
  row: Readonly<Record<string, ScalarLiteral>>,
): boolean {
  switch (expr.kind) {
    case "and":
      return expr.clauses.every((c) => evaluateExpr(c, row));
    case "or":
      return expr.clauses.some((c) => evaluateExpr(c, row));
    case "not":
      return !evaluateExpr(expr.clause, row);
    case "eq":
      return scalarEqual(row[expr.column], expr.value);
    case "neq":
      return !scalarEqual(row[expr.column], expr.value);
    case "gt":
      return compareOrdered(row[expr.column], expr.value) === ">";
    case "gte": {
      const c = compareOrdered(row[expr.column], expr.value);
      return c === ">" || c === "=";
    }
    case "lt":
      return compareOrdered(row[expr.column], expr.value) === "<";
    case "lte": {
      const c = compareOrdered(row[expr.column], expr.value);
      return c === "<" || c === "=";
    }
    case "in":
      return expr.values.some((v) => scalarEqual(row[expr.column], v));
    case "isNull":
      return row[expr.column] === null || row[expr.column] === undefined;
    case "isNotNull":
      return row[expr.column] !== null && row[expr.column] !== undefined;
  }
}

function scalarEqual(a: ScalarLiteral | undefined, b: ScalarLiteral): boolean {
  if (a === undefined) a = null;
  if (a === null || b === null) return a === b;
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (typeof a === "number" && typeof b === "number") return a === b;
  // Cross-type comparisons (number stored, string predicate, or vice versa)
  // fall back to string equality on the canonical form.
  return String(a) === String(b);
}

type Ordering = "<" | "=" | ">" | "incomparable";

function compareOrdered(
  a: ScalarLiteral | undefined,
  b: number | string,
): Ordering {
  if (a === undefined || a === null) return "incomparable";
  if (typeof b === "number") {
    const an = typeof a === "number" ? a : Number(a);
    if (!Number.isFinite(an)) return "incomparable";
    return an < b ? "<" : an > b ? ">" : "=";
  }
  // string predicate value: numeric a is still numerically comparable
  // when the predicate string parses as a number.
  const bn = Number(b);
  const an = typeof a === "number" ? a : Number(a);
  if (Number.isFinite(an) && Number.isFinite(bn)) {
    return an < bn ? "<" : an > bn ? ">" : "=";
  }
  const as = String(a);
  return as < b ? "<" : as > b ? ">" : "=";
}
