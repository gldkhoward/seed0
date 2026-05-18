/**
 * Task 2.11: decomposed readiness score (D8).
 *
 * Two components, each surfaced separately:
 *   - predicateCoverage  = instantiated scenarios / total scenarios
 *   - constraintPassRate = passing records / total records
 *
 * No composite "vibe" number. Callers render the components in the
 * readiness report; the regression check (lib/eval/regression.ts) reads
 * both fields directly.
 */

import type {
  ReadinessReport,
  ScenarioEvaluation,
  ScenarioPlan,
  ValidationReport,
} from "./types";

export function buildReadinessReport(input: {
  plan: ScenarioPlan;
  validation: ValidationReport;
  evaluations: readonly ScenarioEvaluation[];
}): ReadinessReport {
  const total = input.plan.scenarios.length;
  const instantiated = input.evaluations.filter((e) => e.instantiated).length;
  return {
    constraintPassRate: input.validation.passRate,
    predicateCoverage: total === 0 ? 0 : instantiated / total,
    scenarioResults: input.evaluations,
    validation: input.validation,
  };
}
