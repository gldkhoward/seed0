"use server";

import { redirect } from "next/navigation";
import { resumeHook, start } from "workflow/api";

import {
  parseSchema,
  SchemaParseError,
  UnsupportedConstructError,
} from "@/lib/parser";
import { runWorkflow } from "@/workflows/run";
import {
  ensureRunRecord,
  getRun,
  markRunCancelled,
} from "./run-store";
import { HARD_CAPS } from "./ui-types";

export interface SubmitRunResult {
  ok: boolean;
  errors?: Record<string, string>;
  values?: { schema: string; context: string; volume: string };
  truncated?: { volume: number };
}

export async function submitRunAction(
  _prev: SubmitRunResult,
  formData: FormData,
): Promise<SubmitRunResult> {
  const schema = (formData.get("schema") ?? "").toString().trim();
  const context = (formData.get("context") ?? "").toString().trim();
  const rawVolume = (formData.get("volume") ?? "").toString().trim();

  const errors: Record<string, string> = {};
  const values = { schema, context, volume: rawVolume };

  if (schema.length === 0) {
    errors.schema = "Schema is required.";
  } else {
    const bytes = new TextEncoder().encode(schema).byteLength;
    if (bytes > HARD_CAPS.maxSchemaBytes) {
      errors.schema = `Schema is ${bytes.toLocaleString()} bytes; cap is ${HARD_CAPS.maxSchemaBytes.toLocaleString()} bytes.`;
    } else {
      const tableCount = (schema.match(/CREATE\s+TABLE/gi) ?? []).length;
      if (tableCount === 0) {
        errors.schema = "Schema must contain at least one CREATE TABLE statement.";
      } else if (tableCount > HARD_CAPS.maxTables) {
        errors.schema = `Schema declares ${tableCount} tables; cap is ${HARD_CAPS.maxTables}.`;
      }
    }
  }

  if (context.length === 0) {
    errors.context = "Product context is required.";
  } else if (context.length > 4000) {
    errors.context = "Product context must be 4000 characters or fewer.";
  }

  let volume = NaN;
  let truncated: SubmitRunResult["truncated"];
  if (rawVolume.length === 0) {
    errors.volume = "Target volume is required.";
  } else {
    volume = Number.parseInt(rawVolume, 10);
    if (!Number.isFinite(volume) || volume <= 0) {
      errors.volume = "Target volume must be a positive integer.";
    } else if (volume > HARD_CAPS.maxRows) {
      truncated = { volume: HARD_CAPS.maxRows };
      volume = HARD_CAPS.maxRows;
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, values, truncated };
  }

  const wfRun = await start(runWorkflow, [
    { schema, context, volume },
  ]);
  await ensureRunRecord(wfRun.runId, {
    schemaSource: schema,
    productContext: context,
    requestedVolume: volume,
  });
  redirect(`/runs/${wfRun.runId}`);
}

export type ValidateSchemaResult =
  | { ok: true; tables: number }
  | { ok: false; error: string };

/**
 * Frontend pre-flight check for the schema textarea. Reuses the real
 * parser (and the same byte/table caps as submitRunAction) so any
 * "Valid" verdict here will also be accepted by the pipeline. Pure
 * read-only; safe to call on every keystroke (debounced).
 */
export async function validateSchemaAction(
  schema: string,
): Promise<ValidateSchemaResult> {
  const trimmed = schema.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Schema is empty." };
  }
  const bytes = new TextEncoder().encode(trimmed).byteLength;
  if (bytes > HARD_CAPS.maxSchemaBytes) {
    return {
      ok: false,
      error: `Over byte cap (${bytes.toLocaleString()} / ${HARD_CAPS.maxSchemaBytes.toLocaleString()}).`,
    };
  }
  try {
    const model = parseSchema(trimmed);
    if (model.tables.length === 0) {
      return { ok: false, error: "No CREATE TABLE statements found." };
    }
    if (model.tables.length > HARD_CAPS.maxTables) {
      return {
        ok: false,
        error: `${model.tables.length} tables (cap is ${HARD_CAPS.maxTables}).`,
      };
    }
    return { ok: true, tables: model.tables.length };
  } catch (err) {
    if (err instanceof UnsupportedConstructError) {
      return { ok: false, error: `Unsupported: ${err.construct}.` };
    }
    if (err instanceof SchemaParseError) {
      return { ok: false, error: err.message.replace(/^Failed to parse DDL: /, "") };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown parse error.",
    };
  }
}

export async function confirmRunAction(runId: string): Promise<void> {
  await resumeHook(`confirm-${runId}`, { confirmed: true });
  redirect(`/runs/${runId}`);
}

export async function cancelRunAction(runId: string): Promise<void> {
  try {
    await resumeHook(`confirm-${runId}`, { confirmed: false });
  } catch {
    // If the workflow is no longer waiting on the hook (e.g., already
    // past confirm), just mark the run cancelled locally.
    await markRunCancelled(runId, "User cancelled");
  }
  redirect(`/runs`);
}

export async function rerunWithVolumeAction(
  prevRunId: string,
  volume: number,
): Promise<void> {
  const prev = await getRun(prevRunId);
  if (!prev) {
    redirect("/runs");
  }
  const safeVolume = Math.min(Math.max(1, Math.floor(volume)), HARD_CAPS.maxRows);
  const wfRun = await start(runWorkflow, [
    {
      schema: prev!.schemaSource,
      context: prev!.productContext,
      volume: safeVolume,
    },
  ]);
  await ensureRunRecord(wfRun.runId, {
    schemaSource: prev!.schemaSource,
    productContext: prev!.productContext,
    requestedVolume: safeVolume,
  });
  redirect(`/runs/${wfRun.runId}`);
}
