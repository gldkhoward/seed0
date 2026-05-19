/**
 * Schema-keyed dataset cache.
 *
 * When a run successfully produces a canonical dataset we copy it into
 * a content-addressed cache slot. Future runs whose schema (table +
 * column + constraint shape) hash matches can short-circuit generation
 * by reusing one of those datasets.
 *
 * The architect agent (lib/architect-agent.ts) decides whether to
 * actually reuse — it sees candidate summaries (context, scenarios,
 * age, row counts) and can pick none if the prior context is too far
 * from the current one.
 *
 * Storage layout:
 *   cache/<schemaHash>/<runId>.json
 *
 * Each cached entry is a `CachedDatasetEntry` (dataset + summary
 * metadata in one document) so a single Blob read returns everything
 * the architect needs to evaluate a candidate.
 */

import { createHash } from "node:crypto";
import { get, list, put } from "@vercel/blob";

import type {
  CanonicalDataset,
  EntityModel,
  ScenarioPlan,
} from "./types";

const PUT_OPTIONS = {
  access: "private" as const,
  addRandomSuffix: false,
  allowOverwrite: true,
  cacheControlMaxAge: 0,
};

export type CachedDatasetEntry = {
  schemaHash: string;
  sourceRunId: string;
  createdAt: string;
  productContext: string;
  requestedVolume: number;
  scenarioIds: readonly string[];
  totalRows: number;
  tableRowCounts: Readonly<Record<string, number>>;
  dataset: CanonicalDataset;
};

export type CachedDatasetSummary = Omit<CachedDatasetEntry, "dataset">;

function assertBlobToken(): void {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN is required for cache access.",
    );
  }
}

function cachePath(schemaHash: string, runId: string): string {
  return `cache/${schemaHash}/${runId}.json`;
}

/**
 * Deterministic content hash of the structural shape of an entity model.
 * Two schemas with identical tables, columns, types, constraints, and
 * references produce the same hash — table order doesn't matter, column
 * order within a table doesn't matter, and incidental whitespace in
 * raw CHECK strings is normalized out.
 */
export function hashEntityModel(model: EntityModel): string {
  const normalized = model.tables
    .map((t) => ({
      name: t.name,
      columns: [...t.columns]
        .map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          primaryKey: !!c.primaryKey,
          unique: !!c.unique,
          references: c.references
            ? { table: c.references.table, column: c.references.column }
            : null,
          enumValues: c.enumValues ? [...c.enumValues].sort() : null,
          check: c.check ? normalizeWhitespace(c.check) : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      primaryKey: t.primaryKey ? [...t.primaryKey].sort() : null,
      uniqueConstraints: (t.uniqueConstraints ?? [])
        .map((u) => [...u.columns].sort().join(","))
        .sort(),
      checks: (t.checks ?? []).map(normalizeWhitespace).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const json = JSON.stringify(normalized);
  return createHash("sha256").update(json).digest("hex");
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Persist a freshly-generated dataset to the cache. Idempotent; future
 * runs with the same `schemaHash + sourceRunId` overwrite.
 */
export async function putCachedDataset(entry: CachedDatasetEntry): Promise<void> {
  assertBlobToken();
  await put(
    cachePath(entry.schemaHash, entry.sourceRunId),
    JSON.stringify(entry),
    PUT_OPTIONS,
  );
}

/**
 * List candidate cached datasets for a schema hash. Returns lightweight
 * summaries (no dataset payload) so the architect can scan many
 * candidates cheaply, then fetch the chosen one with `getCachedDataset`.
 */
export async function listCachedSummaries(
  schemaHash: string,
  limit = 8,
): Promise<CachedDatasetSummary[]> {
  assertBlobToken();
  const { blobs } = await list({ prefix: `cache/${schemaHash}/` });
  const entries = await Promise.all(
    blobs.slice(0, limit).map(async (b) => {
      try {
        const result = await get(b.pathname, {
          access: "private",
          useCache: false,
        });
        if (!result || result.statusCode !== 200) return undefined;
        const text = await new Response(result.stream).text();
        const parsed = JSON.parse(text) as CachedDatasetEntry;
        const { dataset: _omit, ...summary } = parsed;
        return summary;
      } catch {
        return undefined;
      }
    }),
  );
  return entries
    .filter((e): e is CachedDatasetSummary => !!e)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Fetch a specific cached entry including the dataset payload. Used
 * after the architect has chosen a `sourceRunId` to reuse.
 */
export async function getCachedDataset(
  schemaHash: string,
  sourceRunId: string,
): Promise<CachedDatasetEntry | undefined> {
  assertBlobToken();
  try {
    const result = await get(cachePath(schemaHash, sourceRunId), {
      access: "private",
      useCache: false,
    });
    if (!result || result.statusCode !== 200) return undefined;
    const text = await new Response(result.stream).text();
    return JSON.parse(text) as CachedDatasetEntry;
  } catch {
    return undefined;
  }
}

/**
 * Build a cache entry from a finished run's outputs. Caller is the
 * persist step — only successful or partial runs land here.
 */
export function buildCacheEntry(args: {
  schemaHash: string;
  sourceRunId: string;
  productContext: string;
  requestedVolume: number;
  plan: ScenarioPlan;
  dataset: CanonicalDataset;
}): CachedDatasetEntry {
  const tableRowCounts: Record<string, number> = {};
  let totalRows = 0;
  for (const [t, rows] of Object.entries(args.dataset.tables)) {
    tableRowCounts[t] = rows.length;
    totalRows += rows.length;
  }
  return {
    schemaHash: args.schemaHash,
    sourceRunId: args.sourceRunId,
    createdAt: new Date().toISOString(),
    productContext: args.productContext,
    requestedVolume: args.requestedVolume,
    scenarioIds: args.plan.scenarios.map((s) => s.id),
    totalRows,
    tableRowCounts,
    dataset: args.dataset,
  };
}
