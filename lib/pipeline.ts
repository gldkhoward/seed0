/**
 * Pipeline assembly: wires the deterministic + AI modules into the
 * `Pipeline` contract that lib/eval/regression.ts and the Workflow
 * orchestration in Section 3 consume.
 *
 * `createPipeline` returns the full live pipeline, including the LLM
 * generation step. Tests and the regression runner can substitute a
 * different generator by composing the deterministic pieces directly
 * (see the exports below).
 */

import { createGenerator } from "./generator";
import { parseSchema } from "./parser";
import { evaluatePlan as evaluatePlanFn } from "./predicate-eval";
import { buildReadinessReport } from "./score";
import { validateDataset } from "./validate";
import type { Pipeline } from "./types";

export { parseSchema } from "./parser";
export { generatePlan, bindPlan, PlanBindingError } from "./planner";
export { evaluatePlan, evaluateScenario, evaluatePredicate } from "./predicate-eval";
export { toCanonical, topologicalOrder } from "./canonical";
export { validateDataset } from "./validate";
export { buildReadinessReport } from "./score";
export {
  createGenerator,
  GenerationFailedError,
  type GenerateInput,
  type GeneratorOptions,
} from "./generator";
export { StructuralShapeError } from "./shape-validate";
export {
  UnsupportedConstructError,
  SchemaParseError,
} from "./parser";

export type CreatePipelineOptions = {
  llmModel: string;
  shapeRetryCap?: number;
  repairRetryCap?: number;
};

export function createPipeline(options: CreatePipelineOptions): Pipeline {
  const generator = createGenerator({
    llmModel: options.llmModel,
    shapeRetryCap: options.shapeRetryCap,
    repairRetryCap: options.repairRetryCap,
  });
  return {
    parse(ddl) {
      return parseSchema(ddl);
    },
    async generate(input) {
      return generator.generate(input);
    },
    validate(input) {
      return validateDataset(input.dataset, input.entityModel);
    },
    evaluatePredicates(input) {
      return evaluatePlanFn(input.plan, input.dataset);
    },
    score(input) {
      return buildReadinessReport(input);
    },
  };
}
