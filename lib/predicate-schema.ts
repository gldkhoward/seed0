/**
 * Zod schema for PredicateExpr / Predicate / ScenarioPlan (D11).
 *
 * The planner uses these as the structured-output schema. Kept in a
 * separate module so the runtime evaluator (lib/predicate-eval.ts) can
 * stay zod-free and used in non-AI paths (regression, app rendering).
 */

import { z } from "zod";
import type {
  Predicate,
  PredicateExpr,
  ScalarLiteral,
  Scenario,
  ScenarioPlan,
} from "./types";

const scalarLiteral: z.ZodType<ScalarLiteral> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const orderedValue = z.union([z.number(), z.string()]);

export const predicateExprSchema: z.ZodType<PredicateExpr> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("and"), clauses: z.array(predicateExprSchema) }),
    z.object({ kind: z.literal("or"), clauses: z.array(predicateExprSchema) }),
    z.object({ kind: z.literal("not"), clause: predicateExprSchema }),
    z.object({ kind: z.literal("eq"), column: z.string(), value: scalarLiteral }),
    z.object({ kind: z.literal("neq"), column: z.string(), value: scalarLiteral }),
    z.object({ kind: z.literal("gt"), column: z.string(), value: orderedValue }),
    z.object({ kind: z.literal("gte"), column: z.string(), value: orderedValue }),
    z.object({ kind: z.literal("lt"), column: z.string(), value: orderedValue }),
    z.object({ kind: z.literal("lte"), column: z.string(), value: orderedValue }),
    z.object({ kind: z.literal("in"), column: z.string(), values: z.array(scalarLiteral) }),
    z.object({ kind: z.literal("isNull"), column: z.string() }),
    z.object({ kind: z.literal("isNotNull"), column: z.string() }),
  ]),
);

export const predicateSchema: z.ZodType<Predicate> = z.object({
  table: z.string(),
  where: predicateExprSchema,
});

export const scenarioSchema: z.ZodType<Scenario> = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  predicate: predicateSchema,
});

export const scenarioPlanSchema: z.ZodType<ScenarioPlan> = z.object({
  scenarios: z.array(scenarioSchema),
});
