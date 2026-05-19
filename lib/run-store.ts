/**
 * Vercel Blob-backed run store. Replaces the in-memory map previously
 * shipped as `ui-mock.ts`. Hard-fails on first store access if
 * BLOB_READ_WRITE_TOKEN is missing — there is no local fallback by
 * design, so dev and prod behave identically (D14). The check runs
 * lazily (not at module load) so `next build` can analyze server
 * modules without the env var being present.
 *
 * Storage layout (D15):
 *   runs/{id}/record.json   — RunDetail without canonicalDataset
 *   runs/{id}/dataset.json  — CanonicalDataset (succeeded / partial only)
 *
 * Every state transition flushes record.json (D16). Demo fixtures are
 * seeded on first read against an empty `runs/` prefix so the history
 * view is never empty for a freshly-provisioned Blob store.
 *
 * Concurrency: within a single workflow run, steps execute sequentially
 * so there is no intra-run write race. Different runs touch different
 * keys. Cross-process seeding races are benign because PUTs are
 * idempotent under `allowOverwrite: true`.
 */

import { get, list, put } from "@vercel/blob";

import {
  ECOMMERCE_CONTEXT,
  ECOMMERCE_DDL,
  ECOMMERCE_PLAN,
} from "@/lib/fixtures/ecommerce";
import { tryPublishRunSnapshot } from "@/lib/run-stream";
import type {
  CanonicalDataset,
  ExecutionPlan,
  ReadinessReport,
  ScalarLiteral,
  ScenarioEvaluation,
  ScenarioPlan,
  ValidationReport,
} from "@/lib/types";

import type {
  RunDetail,
  RunStatus,
  RunStep,
  RunSummary,
  StepName,
  StepStatus,
} from "./ui-types";

function assertBlobToken(): void {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN is required. Run `vercel env pull .env.local` after linking the project, or set it manually in .env.local.",
    );
  }
}

const PUT_OPTIONS = {
  access: "private" as const,
  addRandomSuffix: false,
  allowOverwrite: true,
  contentType: "application/json",
  cacheControlMaxAge: 0,
};

const STEP_ORDER: StepName[] = [
  "parse",
  "plan",
  "confirm",
  "cache",
  "generate",
  "validate",
  "repair",
  "predicate-evaluate",
  "coverage-boost",
  "score",
  "persist",
];

function nowIso(offsetSec = 0): string {
  return new Date(Date.now() + offsetSec * 1000).toISOString();
}

function makeSteps(cacheHit: boolean): RunStep[] {
  return STEP_ORDER.map((name) => ({
    name,
    status: name === "generate" && cacheHit ? "skipped" : "pending",
  }));
}

function recordPath(id: string): string {
  return `runs/${id}/record.json`;
}

function datasetPath(id: string): string {
  return `runs/${id}/dataset.json`;
}

async function readJson<T>(pathname: string): Promise<T | undefined> {
  assertBlobToken();
  // `get(pathname, { access: "private" })` is the purpose-built read path
  // for private blobs — it handles auth via BLOB_READ_WRITE_TOKEN. Plain
  // `fetch(url)` against the URLs returned by `list()` is flaky for
  // private stores because those signed URLs are short-lived.
  // `useCache: false` bypasses the CDN cache so step-transition writes
  // are visible to the next read immediately.
  const result = await get(pathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200) return undefined;
  const text = await new Response(result.stream).text();
  return JSON.parse(text) as T;
}

async function writeJson(pathname: string, value: unknown): Promise<void> {
  assertBlobToken();
  await put(pathname, JSON.stringify(value), PUT_OPTIONS);
}

async function readRecord(id: string): Promise<RunDetail | undefined> {
  return readJson<RunDetail>(recordPath(id));
}

async function writeRecord(record: RunDetail): Promise<void> {
  await writeJson(recordPath(record.id), record);
}

async function mutateRecord(
  runId: string,
  fn: (r: RunDetail) => void,
): Promise<void> {
  const record = await readRecord(runId);
  if (!record) return;
  fn(record);
  await writeRecord(record);
  await tryPublishRunSnapshot(record);
}

// -------------------- Writers (workflow + actions) --------------------

export interface EnsureRunInput {
  schemaSource: string;
  productContext: string;
  requestedVolume: number;
}

export async function ensureRunRecord(
  runId: string,
  input: EnsureRunInput,
): Promise<void> {
  await ensureSeededHistory();
  if (await readRecord(runId)) return;
  const tableCount = (input.schemaSource.match(/CREATE\s+TABLE/gi) ?? []).length;
  const record: RunDetail = {
    id: runId,
    createdAt: nowIso(),
    status: "pending_plan",
    schemaSource: input.schemaSource,
    productContext: input.productContext,
    schemaTableCount: tableCount,
    requestedVolume: input.requestedVolume,
    cacheHit: false,
    steps: makeSteps(false),
  };
  await writeRecord(record);
  await tryPublishRunSnapshot(record);
}

export function setRunStatus(runId: string, status: RunStatus): Promise<void> {
  return mutateRecord(runId, (r) => {
    r.status = status;
  });
}

export function setRunStep(
  runId: string,
  step: StepName,
  status: StepStatus,
  note?: string,
  details?: Record<string, unknown>,
): Promise<void> {
  return mutateRecord(runId, (r) => {
    r.steps = r.steps.map((s) => {
      if (s.name !== step) return s;
      const next: RunStep = { ...s, status };
      if (note) next.note = note;
      if (details) next.details = { ...(s.details ?? {}), ...details };
      if (status === "running" && !next.startedAt) next.startedAt = nowIso();
      if (
        status === "succeeded" ||
        status === "failed" ||
        status === "skipped"
      ) {
        next.finishedAt = nowIso();
      }
      return next;
    });
  });
}

export function setRunStepDetails(
  runId: string,
  step: StepName,
  details: Record<string, unknown>,
): Promise<void> {
  return mutateRecord(runId, (r) => {
    r.steps = r.steps.map((s) =>
      s.name === step ? { ...s, details: { ...(s.details ?? {}), ...details } } : s,
    );
  });
}

export function setRunPlan(runId: string, plan: ScenarioPlan): Promise<void> {
  return mutateRecord(runId, (r) => {
    r.plan = plan;
    r.scenariosPlanned = plan.scenarios.length;
  });
}

export function setRunExecutionPlan(
  runId: string,
  execution: ExecutionPlan,
): Promise<void> {
  return mutateRecord(runId, (r) => {
    r.executionPlan = execution;
  });
}

export function setRunSchemaHash(
  runId: string,
  schemaHash: string,
): Promise<void> {
  return mutateRecord(runId, (r) => {
    r.schemaHash = schemaHash;
  });
}

export function setRunCacheHit(
  runId: string,
  cacheHit: boolean,
): Promise<void> {
  return mutateRecord(runId, (r) => {
    r.cacheHit = cacheHit;
  });
}

export function setRunReport(
  runId: string,
  report: ReadinessReport,
): Promise<void> {
  return mutateRecord(runId, (r) => {
    r.report = report;
    r.scenariosInstantiated = report.scenarioResults.filter(
      (sr) => sr.instantiated,
    ).length;
    r.constraintPassRate = report.constraintPassRate;
  });
}

export async function setRunDataset(
  runId: string,
  dataset: CanonicalDataset,
): Promise<void> {
  await writeJson(datasetPath(runId), dataset);
}

export function markRunFailed(runId: string, reason: string): Promise<void> {
  return mutateRecord(runId, (r) => {
    r.status = "failed";
    r.cancellation = { reason };
  });
}

export function markRunCancelled(runId: string, reason: string): Promise<void> {
  return mutateRecord(runId, (r) => {
    r.status = "cancelled";
    r.cancellation = { reason };
  });
}

// -------------------- Readers (server components + routes) --------------------

export async function getRun(id: string): Promise<RunDetail | undefined> {
  await ensureSeededHistory();
  const record = await readRecord(id);
  if (!record) return undefined;
  const dataset = await readJson<CanonicalDataset>(datasetPath(id));
  if (dataset) record.canonicalDataset = dataset;
  return record;
}

export async function listRuns(): Promise<RunSummary[]> {
  await ensureSeededHistory();
  const { blobs } = await list({ prefix: "runs/" });
  const recordBlobs = blobs.filter((b) => b.pathname.endsWith("/record.json"));
  const records = await Promise.all(
    recordBlobs.map(async (b) => {
      try {
        return await readJson<RunDetail>(b.pathname);
      } catch {
        return undefined;
      }
    }),
  );
  return records
    .filter((r): r is RunDetail => !!r)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      status: r.status,
      schemaTableCount: r.schemaTableCount,
      requestedVolume: r.requestedVolume,
      scenariosInstantiated: r.scenariosInstantiated,
      scenariosPlanned: r.scenariosPlanned,
      constraintPassRate: r.constraintPassRate,
      cacheHit: r.cacheHit,
    }));
}

// -------------------- Demo fixture seeding (first read only) --------------------

let seedingPromise: Promise<void> | undefined;

async function ensureSeededHistory(): Promise<void> {
  if (seedingPromise) return seedingPromise;
  seedingPromise = (async () => {
    assertBlobToken();
    const { blobs } = await list({ prefix: "runs/", limit: 1 });
    if (blobs.length > 0) return;
    await seedDemoHistory();
  })();
  try {
    await seedingPromise;
  } catch (e) {
    // Allow retry on next call if the first seed attempt failed.
    seedingPromise = undefined;
    throw e;
  }
}

function buildFixtureDataset(): CanonicalDataset {
  const tableOrder = [
    "customers",
    "addresses",
    "categories",
    "products",
    "inventory",
    "orders",
    "order_items",
    "payments",
  ];
  const tables: Record<string, ReadonlyArray<Record<string, ScalarLiteral>>> = {
    customers: [
      { id: 1, email: "ada@example.com", full_name: "Ada L.", tier: "premium", created_at: "2026-01-04T12:00:00.000Z" },
      { id: 2, email: "noor@example.com", full_name: "Noor S.", tier: "standard", created_at: "2026-02-14T09:31:00.000Z" },
      { id: 3, email: "lee@example.com", full_name: "Lee P.", tier: "free", created_at: "2026-03-08T16:05:00.000Z" },
    ],
    addresses: [
      { id: 1, customer_id: 1, line1: "1 Market St", city: "San Francisco", region: "CA", country: "US", postal_code: "94105" },
      { id: 2, customer_id: 2, line1: "Sheikh Zayed Rd", city: "Dubai", region: null, country: "AE", postal_code: "00000" },
    ],
    categories: [
      { id: 1, name: "Apparel", parent_id: null },
      { id: 2, name: "Tops", parent_id: 1 },
    ],
    products: [
      { id: 1, sku: "TEE-001", name: "Heather grey tee", category_id: 2, price: 29, active: true },
      { id: 2, sku: "JKT-101", name: "Olive field jacket", category_id: 1, price: 189, active: true },
      { id: 3, sku: "TEE-LEG", name: "Legacy tee", category_id: 2, price: 19, active: false },
    ],
    inventory: [
      { product_id: 1, quantity: 120, warehouse: "US-W1" },
      { product_id: 2, quantity: 0, warehouse: "US-W1" },
      { product_id: 3, quantity: 8, warehouse: "EU-W1" },
    ],
    orders: [
      { id: 1, customer_id: 1, shipping_address_id: 1, status: "shipped", total: 58, placed_at: "2026-04-01T14:22:00.000Z" },
      { id: 2, customer_id: 2, shipping_address_id: 2, status: "cancelled", total: 29, placed_at: "2026-04-02T18:10:00.000Z" },
    ],
    order_items: [
      { id: 1, order_id: 1, product_id: 1, quantity: 2, unit_price: 29 },
      { id: 2, order_id: 1, product_id: 2, quantity: 1, unit_price: 189 },
    ],
    payments: [
      { id: 1, order_id: 1, amount: 58, status: "succeeded", processed_at: "2026-04-01T14:22:30.000Z" },
      { id: 2, order_id: 2, amount: 29, status: "failed", processed_at: "2026-04-02T18:12:00.000Z" },
    ],
  };
  return { tables, tableOrder };
}

function buildSeededValidationReport(
  passRate: number,
  withFailures: boolean,
): ValidationReport {
  const totalRecords = 18;
  const passingRecords = Math.round(totalRecords * passRate);
  return {
    totalRecords,
    passingRecords,
    passRate,
    failures: withFailures
      ? [
          {
            table: "order_items",
            rowIndex: 3,
            column: "product_id",
            constraint: "foreign_key",
            detail: "References product_id=999 not present in products.",
          },
          {
            table: "products",
            rowIndex: 4,
            column: "price",
            constraint: "check",
            detail: "Value -5 violates CHECK (price >= 0).",
          },
        ]
      : [],
  };
}

function buildSeededReport(
  plan: ScenarioPlan,
  instantiated: number,
  validation: ValidationReport,
): ReadinessReport {
  const scenarioResults: ScenarioEvaluation[] = plan.scenarios.map((s, i) => ({
    scenarioId: s.id,
    instantiated: i < instantiated,
    matchedRowCount: i < instantiated ? Math.max(1, 3 - i) : 0,
  }));
  return {
    constraintPassRate: validation.passRate,
    predicateCoverage:
      plan.scenarios.length === 0 ? 0 : instantiated / plan.scenarios.length,
    scenarioResults,
    validation,
  };
}

async function seedDemoHistory(): Promise<void> {
  const fixtures: Array<{
    id: string;
    status: RunStatus;
    createdAt: string;
    requestedVolume: number;
    cacheHit: boolean;
    instantiated: number;
    passRate: number;
  }> = [
    {
      id: "r_2026_05_15_ax9",
      status: "succeeded",
      createdAt: "2026-05-15T09:12:00.000Z",
      requestedVolume: 500,
      cacheHit: false,
      instantiated: ECOMMERCE_PLAN.scenarios.length,
      passRate: 1,
    },
    {
      id: "r_2026_05_15_bv2",
      status: "partial",
      createdAt: "2026-05-15T15:33:00.000Z",
      requestedVolume: 2000,
      cacheHit: true,
      instantiated: ECOMMERCE_PLAN.scenarios.length - 1,
      passRate: 0.98,
    },
    {
      id: "r_2026_05_16_cf4",
      status: "failed",
      createdAt: "2026-05-16T11:04:00.000Z",
      requestedVolume: 500,
      cacheHit: false,
      instantiated: 2,
      passRate: 0.72,
    },
  ];

  const fixtureDataset = buildFixtureDataset();

  await Promise.all(
    fixtures.map(async (f) => {
      const steps = makeSteps(f.cacheHit).map<RunStep>((s) => ({
        ...s,
        status:
          f.status === "failed" && s.name === "validate"
            ? "failed"
            : s.status === "skipped"
              ? "skipped"
              : "succeeded",
        startedAt: f.createdAt,
        finishedAt: f.createdAt,
      }));
      const validation = buildSeededValidationReport(
        f.passRate,
        f.status === "failed",
      );
      const report = buildSeededReport(ECOMMERCE_PLAN, f.instantiated, validation);
      const record: RunDetail = {
        id: f.id,
        createdAt: f.createdAt,
        status: f.status,
        schemaSource: ECOMMERCE_DDL,
        productContext: ECOMMERCE_CONTEXT,
        schemaTableCount: 8,
        requestedVolume: f.requestedVolume,
        cacheHit: f.cacheHit,
        scenariosInstantiated: f.instantiated,
        scenariosPlanned: ECOMMERCE_PLAN.scenarios.length,
        constraintPassRate: f.passRate,
        steps,
        plan: ECOMMERCE_PLAN,
        report,
      };
      await writeRecord(record);
      if (f.status === "succeeded" || f.status === "partial") {
        await writeJson(datasetPath(f.id), fixtureDataset);
      }
    }),
  );
}
