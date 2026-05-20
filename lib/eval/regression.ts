/**
 * Evaluation regression check.
 *
 * Runs the pipeline end-to-end against a fixture (ecommerce by default,
 * any other template via `options.fixture`) and asserts:
 *   1. constraint pass rate at or above the threshold (default 100%)
 *   2. predicate-based scenario coverage at or above the threshold
 *      (default 100%)
 *
 * Fails loudly otherwise. This is the Track B evaluation: it is never
 * sacrificed.
 *
 * Pipeline implementation is injected — the runner depends only on the
 * Pipeline interface in @/lib/types, so the eval doesn't couple to the
 * specific generator/repair path. The CLI in scripts/run-eval.ts wraps
 * this with --fixture and --all flags so any template can be gated by
 * the same threshold check that gates ecommerce.
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

/**
 * Minimal fixture shape consumed by the regression. Matches the
 * destructured form of `TemplateEntry` from lib/fixtures/index.ts —
 * any template can be evaluated by passing one of these.
 */
export type RegressionFixture = {
  /** Stable slug used to label output and select via --fixture. */
  slug: string;
  ddl: string;
  context: string;
  plan: ScenarioPlan;
};

/** Default fixture — the only template currently `available: true`. */
export const ECOMMERCE_REGRESSION_FIXTURE: RegressionFixture = {
  slug: "ecommerce",
  ddl: ECOMMERCE_FIXTURE.ddl,
  context: ECOMMERCE_FIXTURE.context,
  plan: ECOMMERCE_FIXTURE.plan,
};

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
  /** Slug of the fixture that was evaluated. */
  fixture: string;
  thresholds: RegressionThresholds;
  report: ReadinessReport;
  dataset: CanonicalDataset;
  failures: readonly string[];
};

export type RegressionOptions = {
  thresholds?: Partial<RegressionThresholds>;
  /** Volume to request from the generator. Default 500 (D7). */
  volume?: number;
  /** Fixture to evaluate. Defaults to ECOMMERCE_REGRESSION_FIXTURE. */
  fixture?: RegressionFixture;
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
  const fixture = options.fixture ?? ECOMMERCE_REGRESSION_FIXTURE;
  const thresholds: RegressionThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...options.thresholds,
  };
  const volume = options.volume ?? 500;

  const entityModel = pipeline.parse(fixture.ddl);
  const plan: ScenarioPlan = fixture.plan;

  const dataset = await pipeline.generate({
    entityModel,
    context: fixture.context,
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
    fixture: fixture.slug,
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
      `Regression failed for "${result.fixture}" (${result.failures.length} threshold miss${
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
