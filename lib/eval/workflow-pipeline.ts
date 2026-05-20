/**
 * Workflow-path pipeline for the regression eval.
 *
 * Wires the same lib/ primitives the production workflow uses —
 * `chunkedGenerate` + `repair-agent` + the deterministic validators —
 * into the Pipeline interface, so `pnpm eval` measures what actually
 * ships rather than the legacy single-call generator.
 *
 * Differences from the workflow itself (deliberate):
 *   - No architect agent. `synthesizeDeterministicPlan` provides the
 *     execution plan (even allocation, one parallel wave, regenerate).
 *     The eval therefore measures generation + repair quality with a
 *     fixed plan, isolating the LLM-structured-output and tool-call
 *     concerns from architect planning variance. The architect is
 *     exercised by every live demo run and observable in the
 *     `agent:thoughts` stream — it doesn't need a duplicate gate.
 *   - No human-confirm hook, no cache rehydrate, no Blob writes. The
 *     eval bypasses the workflow runtime entirely; this is a pure
 *     async function chain.
 *
 * Model staging mirrors production: Sonnet for the repair-agent's
 * tool-call loop, Haiku for bulk generation in chunked-generator.
 *
 * Side effects the workflow normally emits (setRunStep,
 * publishAgentThought, run-store persistence) are absent here:
 * progress callbacks aren't passed, and the stream publishers in
 * lib/run-stream.ts silently no-op when `getWritable()` throws (no
 * workflow context). No code paths require Blob.
 */

import { synthesizeDeterministicPlan } from "@/lib/architect-agent";
import { toCanonical } from "@/lib/canonical";
import { chunkedGenerate } from "@/lib/chunked-generator";
import { parseSchema } from "@/lib/parser";
import { evaluatePlan } from "@/lib/predicate-eval";
import { runRepairAgent } from "@/lib/repair-agent";
import { buildReadinessReport } from "@/lib/score";
import { validateShape } from "@/lib/shape-validate";
import type { Pipeline } from "@/lib/types";
import { validateDataset } from "@/lib/validate";

const DEFAULT_JUDGMENT_MODEL = "anthropic/claude-sonnet-4-6";
const DEFAULT_GENERATION_MODEL = "anthropic/claude-haiku-4-5";
const DEFAULT_REPAIR_STEP_CAP = 24;

export type WorkflowPipelineOptions = {
  /** Model used for the repair-agent's tool-call loop. Defaults to Sonnet 4.6. */
  judgmentModel?: string;
  /** Model used for bulk generation in chunked-generator. Defaults to Haiku 4.5. */
  generationModel?: string;
  /** Hard cap on repair-agent tool-call steps. Default 24. */
  repairStepCap?: number;
};

export function createWorkflowPipeline(
  options: WorkflowPipelineOptions = {},
): Pipeline {
  const judgmentModel = options.judgmentModel ?? DEFAULT_JUDGMENT_MODEL;
  const generationModel =
    options.generationModel ?? DEFAULT_GENERATION_MODEL;
  const repairStepCap = options.repairStepCap ?? DEFAULT_REPAIR_STEP_CAP;

  return {
    parse(ddl) {
      return parseSchema(ddl);
    },

    async generate(input) {
      // Deterministic execution plan from the fixture's scenarios —
      // see header comment for why the architect is bypassed here.
      const architectPlan = synthesizeDeterministicPlan({
        entityModel: input.entityModel,
        scenarios: input.plan,
        volume: input.volume,
      });

      const generated = await chunkedGenerate({
        entityModel: input.entityModel,
        plan: input.plan,
        volume: input.volume,
        productContext: input.context,
        llmModel: generationModel,
        externalAllocations: architectPlan.execution.tableAllocations,
        externalParallelGroups: architectPlan.execution.parallelGroups,
      });

      const validated = validateShape(generated.rows, input.entityModel);
      let canonical = toCanonical(validated, input.entityModel);
      const initialValidation = validateDataset(canonical, input.entityModel);

      // Only invoke the repair-agent when the deterministic validator
      // surfaced failures — same conditional gating the workflow uses.
      if (initialValidation.failures.length > 0) {
        const repairResult = await runRepairAgent({
          initialDataset: validated,
          initialFailures: initialValidation.failures,
          entityModel: input.entityModel,
          plan: input.plan,
          productContext: input.context,
          llmModel: judgmentModel,
          stepCap: repairStepCap,
        });
        canonical = toCanonical(repairResult.dataset, input.entityModel);
      }

      return canonical;
    },

    validate(input) {
      return validateDataset(input.dataset, input.entityModel);
    },

    evaluatePredicates(input) {
      return evaluatePlan(input.plan, input.dataset);
    },

    score(input) {
      return buildReadinessReport(input);
    },
  };
}
