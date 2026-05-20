/**
 * Regression entrypoint. Runs the eval against one or more fixtures
 * via the live AI Gateway and exits non-zero on threshold miss.
 *
 * Usage:
 *   pnpm eval                          # ecommerce (default)
 *   pnpm eval -- --fixture <slug>      # specific template
 *   pnpm eval -- --all                 # every TEMPLATES entry
 *   pnpm eval -- --volume 250          # override volume
 *
 * Requires AI_GATEWAY_API_KEY to be set. Does NOT require Blob — the
 * regression talks to the pipeline directly, bypassing the workflow
 * runtime and persistence layers.
 *
 * The pipeline used here is the workflow-path pipeline
 * (lib/eval/workflow-pipeline.ts) — chunked-generator + repair-agent,
 * the same code the production workflow runs. The architect step is
 * substituted with synthesizeDeterministicPlan so the eval isolates
 * generation + repair quality from planning variance; the architect
 * is exercised by every live demo run.
 *
 * Exit code is the gate: any FAIL or ERROR across the selected
 * fixture(s) → exit 1. A clean run-all is the basis for flipping a
 * template's `available: true` in app/page.tsx — clicking through to
 * an un-eval'd surface should be structurally impossible.
 */

import { TEMPLATES, type TemplateEntry } from "../lib/fixtures";
import { createWorkflowPipeline } from "../lib/eval/workflow-pipeline";
import {
  runRegression,
  type RegressionFixture,
  type RegressionResult,
} from "../lib/eval/regression";

const JUDGMENT_MODEL =
  process.env.SEED0_EVAL_MODEL ?? "anthropic/claude-sonnet-4-6";
const GENERATION_MODEL =
  process.env.SEED0_GEN_MODEL ?? "anthropic/claude-haiku-4-5";

type ParsedArgs = {
  fixture?: string;
  all: boolean;
  volume?: number;
};

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") {
      out.all = true;
    } else if (a === "--fixture" && i + 1 < argv.length) {
      out.fixture = argv[++i];
    } else if (a === "--volume" && i + 1 < argv.length) {
      const v = Number.parseInt(argv[++i]!, 10);
      if (Number.isFinite(v) && v > 0) out.volume = v;
    }
  }
  return out;
}

function toRegressionFixture(tpl: TemplateEntry): RegressionFixture {
  return {
    slug: tpl.slug,
    ddl: tpl.ddl,
    context: tpl.context,
    plan: tpl.fixture.plan,
  };
}

function pickTemplates(args: ParsedArgs): TemplateEntry[] {
  if (args.all) return [...TEMPLATES];
  const slug = args.fixture ?? "ecommerce";
  const tpl = TEMPLATES.find((t) => t.slug === slug);
  if (!tpl) {
    console.error(
      `No fixture matching "${slug}". Available: ${TEMPLATES.map((t) => t.slug).join(", ")}`,
    );
    process.exit(2);
  }
  return [tpl];
}

function formatLine(slug: string, result: RegressionResult): string {
  const tick = result.pass ? "PASS" : "FAIL";
  return (
    `  ${tick}  ${slug.padEnd(11)} ` +
    `constraints=${(result.report.constraintPassRate * 100).toFixed(1)}% ` +
    `coverage=${(result.report.predicateCoverage * 100).toFixed(1)}%`
  );
}

async function main() {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error(
      "AI_GATEWAY_API_KEY is required. Run `vercel env pull .env.local` or set it manually.",
    );
    process.exit(2);
  }

  const args = parseArgs(process.argv.slice(2));
  const templates = pickTemplates(args);
  const pipeline = createWorkflowPipeline({
    judgmentModel: JUDGMENT_MODEL,
    generationModel: GENERATION_MODEL,
  });
  const volume = args.volume ?? 500;

  console.log(
    `seed0 regression · judgment=${JUDGMENT_MODEL} · generation=${GENERATION_MODEL}`,
  );
  console.log(
    `              volume=${volume} · ${templates.length} fixture(s)`,
  );

  let anyFailed = false;
  const results: Array<{
    slug: string;
    result?: RegressionResult;
    error?: string;
  }> = [];

  for (const tpl of templates) {
    console.log(`\n→ ${tpl.slug}`);
    try {
      const result = await runRegression(pipeline, {
        fixture: toRegressionFixture(tpl),
        volume,
      });
      console.log(formatLine(tpl.slug, result));
      if (!result.pass) {
        for (const f of result.failures) console.log(`        - ${f}`);
        anyFailed = true;
      }
      results.push({ slug: tpl.slug, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ERROR ${tpl.slug.padEnd(11)} ${msg}`);
      anyFailed = true;
      results.push({ slug: tpl.slug, error: msg });
    }
  }

  if (templates.length > 1) {
    const passed = results.filter((r) => r.result?.pass).length;
    console.log(`\nSummary: ${passed}/${templates.length} passed`);
  }

  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
