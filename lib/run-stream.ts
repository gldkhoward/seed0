/**
 * Live progress publishing for the seed-run workflow.
 *
 * Each run mutation in run-store.ts calls `tryPublishRunSnapshot` after
 * persisting the new RunDetail. Inside a workflow step, the snapshot is
 * appended to the workflow run's default stream via `getWritable()`. The
 * /runs/[id]/events Route Handler pipes that stream straight to the
 * browser, so live progress updates are push-based — no client polling,
 * no `router.refresh()`.
 *
 * Outside a step (server actions, history seeding, cron sweeps),
 * `getWritable()` throws. We swallow the error so the same mutators work
 * everywhere — the route handler falls back to serving the latest stored
 * record for runs whose workflow stream is no longer open.
 */

import { getWritable } from "workflow";

import type { AgentThought } from "./types";
import type { RunDetail } from "./ui-types";

const encoder = new TextEncoder();

export const AGENT_THOUGHTS_NAMESPACE = "agent:thoughts";

export async function tryPublishRunSnapshot(snapshot: RunDetail): Promise<void> {
  let writable: WritableStream<Uint8Array>;
  try {
    writable = getWritable<Uint8Array>();
  } catch {
    return;
  }
  const writer = writable.getWriter();
  try {
    await writer.write(encoder.encode(JSON.stringify(snapshot) + "\n"));
  } catch {
    // Writer may be closed if the workflow already finished — fine.
  } finally {
    try {
      writer.releaseLock();
    } catch {
      // Already released — ignore.
    }
  }
}

/**
 * Publish one agent narration line to the `agent:thoughts` namespaced
 * stream. The /runs/[id]/agent route reads from this namespace and
 * pipes it to the browser separately from the main step-snapshot
 * stream, so the agent's reasoning has its own UI channel.
 *
 * Safe to call outside a workflow step — silently no-ops if no writable
 * stream is available (e.g. running from a server action).
 */
export async function publishAgentThought(thought: AgentThought): Promise<void> {
  let writable: WritableStream<Uint8Array>;
  try {
    writable = getWritable<Uint8Array>({ namespace: AGENT_THOUGHTS_NAMESPACE });
  } catch {
    return;
  }
  const writer = writable.getWriter();
  try {
    await writer.write(encoder.encode(JSON.stringify(thought) + "\n"));
  } catch {
    // Stream closed — fine.
  } finally {
    try {
      writer.releaseLock();
    } catch {
      // Already released.
    }
  }
}
