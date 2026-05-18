/**
 * Evaluation regression check (task 5.3).
 *
 * Runs the pipeline end-to-end against the fixed ecommerce demo fixture
 * and asserts:
 *   1. 100% hard-constraint pass rate
 *   2. predicate-based scenario coverage at or above the threshold
 *
 * Fails loudly otherwise. This is the Track B evaluation: it is never
 * sacrificed even if Section 6 is cut.
 *
 * Pipeline implementation is injected — the runner depends only on the
 * Pipeline interface in @/lib/types, so the other parallel agents can
 * implement against it without coupling.
 */

import { ECOMMERCE_FIXTURE } from "@/lib/fixtures/ecommerce";
import type {
  CanonicalDataset,
  Pipeline,
  ReadinessReport,
  ScenarioEvaluation,
  ScenarioPlan,
  ValidationReport,
} from "@/lib/types";

export type RegressionThresholds = {
  /** Minimum constraint pass rate. Defaults to 1.0 (100%). */
  constraintPassRate: number;
  /** Minimum predicate-based scenario coverage (0..1). Defaults to 1.0. */
  predicateCoverage: number;
};

export const DEFAULT_THRESHOLDS: RegressionThresholds = {
  constraintPassRate: 1.0,
  predicateCoverage: 1.0,
};

export type RegressionResult = {
  pass: boolean;
  thresholds: RegressionThresholds;
  report: ReadinessReport;
  dataset: CanonicalDataset;
  failures: readonly string[];
};

export type RegressionOptions = {
  thresholds?: Partial<RegressionThresholds>;
  /** Volume to request from the generator. Default 500 (D7). */
  volume?: number;
};

/**
 * Execute the regression and return a structured result. Does NOT throw
 * on threshold miss — callers wanting hard-failure semantics use
 * {@link assertRegression}.
 */
export async function runRegression(
  pipeline: Pipeline,
  options: RegressionOptions = {},
): Promise<RegressionResult> {
  const thresholds: RegressionThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...options.thresholds,
  };
  const volume = options.volume ?? 500;

  const entityModel = pipeline.parse(ECOMMERCE_FIXTURE.ddl);
  const plan: ScenarioPlan = ECOMMERCE_FIXTURE.plan;

  const dataset = await pipeline.generate({
    entityModel,
    context: ECOMMERCE_FIXTURE.context,
    plan,
    volume,
  });

  const validation: ValidationReport = pipeline.validate({
    entityModel,
    dataset,
  });
  const evaluations: readonly ScenarioEvaluation[] = pipeline.evaluatePredicates({
    plan,
    dataset,
  });
  const report = pipeline.score({ plan, validation, evaluations });

  const failures: string[] = [];
  if (report.constraintPassRate < thresholds.constraintPassRate) {
    failures.push(
      `constraint pass rate ${formatRate(report.constraintPassRate)} ` +
        `below threshold ${formatRate(thresholds.constraintPassRate)}; ` +
        `${validation.failures.length} constraint failure(s)`,
    );
  }
  if (report.predicateCoverage < thresholds.predicateCoverage) {
    const missing = evaluations
      .filter((e) => !e.instantiated)
      .map((e) => e.scenarioId);
    failures.push(
      `predicate coverage ${formatRate(report.predicateCoverage)} ` +
        `below threshold ${formatRate(thresholds.predicateCoverage)}; ` +
        `missing scenarios: ${missing.join(", ") || "(none reported)"}`,
    );
  }

  return {
    pass: failures.length === 0,
    thresholds,
    report,
    dataset,
    failures,
  };
}

/**
 * Run the regression and throw with a structured message if either
 * threshold is missed. Use this from CI / test runners — "fail loudly".
 */
export async function assertRegression(
  pipeline: Pipeline,
  options: RegressionOptions = {},
): Promise<RegressionResult> {
  const result = await runRegression(pipeline, options);
  if (!result.pass) {
    throw new RegressionFailure(result);
  }
  return result;
}

export class RegressionFailure extends Error {
  readonly result: RegressionResult;
  constructor(result: RegressionResult) {
    super(
      `Demo regression failed (${result.failures.length} threshold miss${
        result.failures.length === 1 ? "" : "es"
      }):\n  - ${result.failures.join("\n  - ")}`,
    );
    this.name = "RegressionFailure";
    this.result = result;
  }
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
