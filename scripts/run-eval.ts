/**
 * Task 5.3 entrypoint. Runs the fixed ecommerce regression against the
 * live AI Gateway pipeline and exits non-zero on threshold miss.
 *
 * Usage:
 *   pnpm eval                  # default thresholds (100% / 100%)
 *   pnpm eval -- --volume 250  # override volume
 *
 * Requires AI_GATEWAY_API_KEY to be set. Does NOT require Blob — the
 * regression talks to the pipeline directly, bypassing the workflow and
 * persistence layers.
 */

import { createPipeline } from "../lib/pipeline";
import { assertRegression, RegressionFailure } from "../lib/eval/regression";

const LLM_MODEL = process.env.SEED0_EVAL_MODEL ?? "anthropic/claude-sonnet-4-6";

function parseVolume(argv: string[]): number | undefined {
  const idx = argv.findIndex((a) => a === "--volume");
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  const n = Number.parseInt(argv[idx + 1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function main() {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error(
      "AI_GATEWAY_API_KEY is required. Run `vercel env pull .env.local` or set it manually.",
    );
    process.exit(2);
  }

  const volume = parseVolume(process.argv.slice(2));
  const pipeline = createPipeline({ llmModel: LLM_MODEL });

  console.log(`seed0 regression · model=${LLM_MODEL} · volume=${volume ?? 500}`);
  const result = await assertRegression(pipeline, { volume });
  console.log(
    `PASS · constraintPassRate=${(result.report.constraintPassRate * 100).toFixed(1)}%` +
      ` · predicateCoverage=${(result.report.predicateCoverage * 100).toFixed(1)}%`,
  );
}

main().catch((err) => {
  if (err instanceof RegressionFailure) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
