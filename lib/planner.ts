/**
 * Task 2.3: scenario planner (D11).
 *
 * Generates a ScenarioPlan from the parsed entity model + product
 * context using the AI SDK with a constrained zod schema. Every
 * scenario carries a typed PredicateExpr bound to columns in the
 * model; the model proposes, deterministic code (`bindPlan`) verifies
 * that every predicate references only known tables and columns.
 *
 * A plan that fails binding is rejected; the caller wraps this in a
 * bounded retry. We do not transparently retry inside `generatePlan`
 * because Workflow-level retry scoping (run-orchestration spec) is the
 * authoritative place for that decision.
 */

import { structuredOutput } from "./ai";
import { scenarioPlanSchema } from "./predicate-schema";
import type {
  EntityModel,
  PredicateExpr,
  Scenario,
  ScenarioPlan,
} from "./types";

export class PlanBindingError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Plan rejected: ${issues.join("; ")}`);
    this.name = "PlanBindingError";
    this.issues = issues;
  }
}

export function bindPlan(plan: ScenarioPlan, model: EntityModel): void {
  const tableColumns = new Map<string, Set<string>>();
  for (const t of model.tables) {
    tableColumns.set(t.name, new Set(t.columns.map((c) => c.name)));
  }
  const issues: string[] = [];
  const seenIds = new Set<string>();
  for (const s of plan.scenarios) {
    if (!s.id) issues.push("scenario with empty id");
    else if (seenIds.has(s.id)) issues.push(`duplicate scenario id ${s.id}`);
    else seenIds.add(s.id);
    bindScenario(s, tableColumns, issues);
  }
  if (issues.length > 0) throw new PlanBindingError(issues);
}

function bindScenario(
  s: Scenario,
  tableColumns: Map<string, Set<string>>,
  issues: string[],
): void {
  const table = s.predicate.table;
  const cols = tableColumns.get(table);
  if (!cols) {
    issues.push(`scenario ${s.id}: unknown table ${table}`);
    return;
  }
  bindExpr(s.id, table, s.predicate.where, cols, issues);
}

function bindExpr(
  scenarioId: string,
  table: string,
  expr: PredicateExpr,
  cols: Set<string>,
  issues: string[],
): void {
  switch (expr.kind) {
    case "and":
    case "or":
      expr.clauses.forEach((c) => bindExpr(scenarioId, table, c, cols, issues));
      return;
    case "not":
      bindExpr(scenarioId, table, expr.clause, cols, issues);
      return;
    default: {
      const col = (expr as { column: string }).column;
      if (!cols.has(col)) {
        issues.push(
          `scenario ${scenarioId}: predicate references unknown column ${table}.${col}`,
        );
      }
    }
  }
}

const PLANNER_SYSTEM = `You design verifiable scenario plans for seed-data generation.

Each scenario is a named, business-meaningful situation that the seed data
should cover (e.g. "delivered order to a returning customer"). Every
scenario carries a structured *predicate* — a typed condition expression
over rows of a single named table. The predicate is what tools
deterministically check after generation; the model never self-attests to
whether a scenario is covered.

Predicate grammar (use only these shapes; tables and columns must exist
in the provided entity model; use lowercase identifiers; do not invent
names):

Predicate = { table: string; where: PredicateExpr }

PredicateExpr =
  | { kind: "and"; clauses: PredicateExpr[] }
  | { kind: "or"; clauses: PredicateExpr[] }
  | { kind: "not"; clause: PredicateExpr }
  | { kind: "eq" | "neq"; column: string; value: scalar }
  | { kind: "gt" | "gte" | "lt" | "lte"; column: string; value: number | string }
  | { kind: "in"; column: string; values: scalar[] }
  | { kind: "isNull" | "isNotNull"; column: string }

scalar = string | number | boolean | null.

A scenario is satisfied when at least one row in the named table makes
the where-expression true. Prefer strict equality on enum/state columns
and explicit comparisons on numerics. Free text and SQL are not accepted.
`;

export type PlannerInput = {
  model: EntityModel;
  productContext: string;
  llmModel: string;
  scenarioCount?: number;
};

export async function generatePlan(input: PlannerInput): Promise<ScenarioPlan> {
  const target = input.scenarioCount ?? 8;
  const prompt = [
    `Product context:`,
    input.productContext.trim(),
    "",
    `Entity model:`,
    describeModel(input.model),
    "",
    `Produce ${target} named scenarios. Each scenario:`,
    `- has a kebab-case id, a human-readable name, a 1-2 sentence description,`,
    `- carries a Predicate referencing only the tables and columns above.`,
  ].join("\n");

  const { object } = await structuredOutput({
    model: input.llmModel,
    schema: scenarioPlanSchema,
    system: PLANNER_SYSTEM,
    prompt,
  });

  bindPlan(object, input.model);
  return object;
}

function describeModel(model: EntityModel): string {
  return model.tables
    .map((t) => {
      const cols = t.columns
        .map((c) => {
          const bits: string[] = [c.type];
          if (!c.nullable) bits.push("not null");
          if (c.primaryKey) bits.push("primary key");
          else if (c.unique) bits.push("unique");
          if (c.references)
            bits.push(`→ ${c.references.table}.${c.references.column}`);
          if (c.enumValues) bits.push(`enum=[${c.enumValues.join("|")}]`);
          if (c.check) bits.push(`check=${c.check}`);
          return `    ${c.name} (${bits.join(", ")})`;
        })
        .join("\n");
      return `  ${t.name}\n${cols}`;
    })
    .join("\n");
}
