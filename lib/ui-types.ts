/**
 * UI view-model types. Canonical pipeline shapes (Predicate, Scenario,
 * ScenarioPlan, CanonicalDataset, ReadinessReport, ValidationReport) live
 * in `@/lib/types` and are imported here. This module only owns surfaces
 * the pipeline does not: run lifecycle, workflow step list, hard caps,
 * deterministic cost estimate, and predicate formatting for display.
 */

import type {
  PredicateExpr,
  ScalarLiteral,
  ScenarioPlan,
  CanonicalDataset,
  ReadinessReport,
} from "@/lib/types";

export type RunStatus =
  | "pending_plan"
  | "awaiting_confirmation"
  | "running"
  | "cancelled"
  | "succeeded"
  | "partial"
  | "failed";

export type StepName =
  | "parse"
  | "plan"
  | "confirm"
  | "cache"
  | "generate"
  | "validate"
  | "repair"
  | "predicate-evaluate"
  | "score"
  | "persist";

export type StepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export interface RunStep {
  name: StepName;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  note?: string;
  /**
   * Step-specific output payload, set by the workflow as steps complete.
   * Schema is loose (JSON) so steps can evolve their output without a
   * type migration; the run-progress UI has a per-step renderer that
   * knows the shape it expects for each StepName.
   */
  details?: Record<string, unknown>;
}

export interface RunSummary {
  id: string;
  createdAt: string;
  status: RunStatus;
  schemaTableCount: number;
  requestedVolume: number;
  scenariosInstantiated?: number;
  scenariosPlanned?: number;
  constraintPassRate?: number;
  cacheHit?: boolean;
}

export interface RunDetail extends RunSummary {
  schemaSource: string;
  productContext: string;
  steps: RunStep[];
  plan?: ScenarioPlan;
  report?: ReadinessReport;
  cancellation?: { reason: string };
  canonicalDataset?: CanonicalDataset;
}

export const HARD_CAPS = {
  maxSchemaBytes: 32_000,
  maxTables: 25,
  maxRows: 5_000,
  maxWallClockSeconds: 300,
} as const;

/**
 * D12 deterministic pre-run cost arithmetic. Not a predictive model.
 * Inputs are user volume × posted per-row token estimate × model price,
 * plus a fixed planning cost.
 */
export const COST_ASSUMPTIONS = {
  estimatedTokensPerRow: 220,
  modelPricePerMTokens: 3.0,
  fixedPlanningUsd: 0.02,
} as const;

export interface CostEstimate {
  rows: number;
  tokensPerRow: number;
  generationTokens: number;
  modelPricePerMTokens: number;
  generationUsd: number;
  planningUsd: number;
  totalUsd: number;
}

export function estimateRunCost(volume: number): CostEstimate {
  const generationTokens = volume * COST_ASSUMPTIONS.estimatedTokensPerRow;
  const generationUsd =
    (generationTokens / 1_000_000) * COST_ASSUMPTIONS.modelPricePerMTokens;
  return {
    rows: volume,
    tokensPerRow: COST_ASSUMPTIONS.estimatedTokensPerRow,
    generationTokens,
    modelPricePerMTokens: COST_ASSUMPTIONS.modelPricePerMTokens,
    generationUsd,
    planningUsd: COST_ASSUMPTIONS.fixedPlanningUsd,
    totalUsd: generationUsd + COST_ASSUMPTIONS.fixedPlanningUsd,
  };
}

export function formatUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatScalar(v: ScalarLiteral | number | string | boolean | null): string {
  if (v === null) return "NULL";
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

/**
 * Render a `PredicateExpr` (from `@/lib/types`) as a single-line, readable
 * string for display in scenario cards and the readiness report. The
 * canonical evaluator owns truth; this is purely cosmetic.
 */
export function formatPredicateExpr(expr: PredicateExpr): string {
  switch (expr.kind) {
    case "and":
      return expr.clauses.map((c) => wrap(c)).join(" AND ");
    case "or":
      return expr.clauses.map((c) => wrap(c)).join(" OR ");
    case "not":
      return `NOT ${wrap(expr.clause)}`;
    case "eq":
      return `${expr.column} = ${formatScalar(expr.value)}`;
    case "neq":
      return `${expr.column} != ${formatScalar(expr.value)}`;
    case "gt":
      return `${expr.column} > ${formatScalar(expr.value)}`;
    case "gte":
      return `${expr.column} >= ${formatScalar(expr.value)}`;
    case "lt":
      return `${expr.column} < ${formatScalar(expr.value)}`;
    case "lte":
      return `${expr.column} <= ${formatScalar(expr.value)}`;
    case "in":
      return `${expr.column} IN (${expr.values.map(formatScalar).join(", ")})`;
    case "isNull":
      return `${expr.column} IS NULL`;
    case "isNotNull":
      return `${expr.column} IS NOT NULL`;
  }
}

function wrap(expr: PredicateExpr): string {
  if (expr.kind === "and" || expr.kind === "or") {
    return `(${formatPredicateExpr(expr)})`;
  }
  return formatPredicateExpr(expr);
}
