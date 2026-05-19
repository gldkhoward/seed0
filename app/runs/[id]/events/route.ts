/**
 * Live run-progress stream.
 *
 * Pipes the workflow run's default writable (populated by
 * tryPublishRunSnapshot on every state mutation) directly to the browser
 * as newline-delimited JSON. For runs that don't have a live workflow
 * stream — terminal runs viewed after the fact, seeded history
 * fixtures — we serve the latest stored snapshot once and close.
 *
 * No client polling, no router.refresh(): one server connection per run
 * regardless of viewers, push-based deltas the moment a step transitions.
 *
 * Resumable per Vercel Workflows: ?startIndex=N replays from chunk N so
 * a reconnecting client doesn't miss snapshots written while it was
 * disconnected.
 */

import { getRun as getWorkflowRun } from "workflow/api";

import { getRun as getRunRecord } from "@/lib/run-store";

// Streaming responses must run on the server; Fluid Compute keeps the
// connection open as long as the workflow run is writing.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const NDJSON_HEADERS: HeadersInit = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  // Disable proxy buffering so each snapshot reaches the browser as
  // soon as the workflow writes it.
  "X-Accel-Buffering": "no",
};

const encoder = new TextEncoder();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const startIndexParam = url.searchParams.get("startIndex");
  const startIndex = startIndexParam
    ? Number.parseInt(startIndexParam, 10)
    : undefined;

  const workflowRun = getWorkflowRun(id);
  const exists = await workflowRun.exists.catch(() => false);

  if (exists) {
    const stream = workflowRun.getReadable({
      startIndex: Number.isFinite(startIndex) ? startIndex : undefined,
    });
    return new Response(stream, { headers: NDJSON_HEADERS });
  }

  // No live workflow stream — emit the latest stored snapshot once so the
  // client has fresh state, then close.
  const record = await getRunRecord(id);
  if (!record) {
    return new Response("not found", { status: 404 });
  }
  return new Response(encoder.encode(JSON.stringify(record) + "\n"), {
    headers: NDJSON_HEADERS,
  });
}
