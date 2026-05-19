/**
 * Agent thoughts stream.
 *
 * Pipes the workflow run's `agent:thoughts` namespaced stream straight
 * to the browser as newline-delimited JSON. The architect and repair
 * agents publish narration events to this namespace
 * (`lib/run-stream.ts:publishAgentThought`), giving the UI a dedicated
 * channel for live reasoning that's independent of the main step
 * snapshot stream.
 *
 * Terminal runs have no live workflow stream, so we return 204 — the
 * UI panel hides itself in that case.
 */

import { getRun as getWorkflowRun } from "workflow/api";

import { AGENT_THOUGHTS_NAMESPACE } from "@/lib/run-stream";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NDJSON_HEADERS: HeadersInit = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

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
  if (!exists) {
    return new Response(null, { status: 204 });
  }

  const stream = workflowRun.getReadable({
    namespace: AGENT_THOUGHTS_NAMESPACE,
    startIndex: Number.isFinite(startIndex) ? startIndex : undefined,
  });
  return new Response(stream, { headers: NDJSON_HEADERS });
}
