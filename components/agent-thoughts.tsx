"use client";

/**
 * Agent narration panel.
 *
 * Subscribes to `/runs/[id]/agent` — a namespaced workflow stream
 * carrying `AgentThought` events published by the architect and repair
 * agents. Renders them as a live, append-only list beside the step
 * timeline so users can watch the agent reason through cache reuse,
 * scenario design, and repair decisions in real time.
 *
 * On terminal runs the route returns 204; we render nothing in that
 * case (the timeline already shows what happened).
 */

import { useEffect, useRef, useState } from "react";
import { Brain, Sparkles } from "lucide-react";

import type { AgentThought } from "@/lib/types";
import type { RunDetail } from "@/lib/ui-types";

interface AgentThoughtsProps {
  runId: string;
  status: RunDetail["status"];
}

const TERMINAL = new Set<RunDetail["status"]>([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);

export function AgentThoughts({ runId, status }: AgentThoughtsProps) {
  const [thoughts, setThoughts] = useState<AgentThought[]>([]);
  const [open, setOpen] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (TERMINAL.has(status)) return;
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/runs/${runId}/agent`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (res.status === 204 || !res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            try {
              const thought = JSON.parse(line) as AgentThought;
              setThoughts((prev) => [...prev, thought]);
            } catch {
              // Malformed line — skip.
            }
          }
        }
      } catch {
        // Aborted on unmount.
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [runId, status]);

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [thoughts.length]);

  // Hide the panel entirely on terminal runs that produced no thoughts —
  // there's nothing to show after the fact since the stream only lives
  // for the duration of the workflow.
  if (TERMINAL.has(status) && thoughts.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <Brain className="size-3.5 text-primary" aria-hidden />
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Agent reasoning
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            · {thoughts.length} {thoughts.length === 1 ? "thought" : "thoughts"}
          </span>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          {open ? "hide" : "show"}
        </span>
      </button>
      {open ? (
        <div
          ref={containerRef}
          className="flex max-h-72 flex-col gap-1.5 overflow-y-auto border-t border-border/60 px-4 py-3"
        >
          {thoughts.length === 0 ? (
            <p className="font-mono text-[11px] text-muted-foreground">
              Listening for agent narration…
            </p>
          ) : (
            thoughts.map((t, i) => <ThoughtRow key={i} thought={t} />)
          )}
        </div>
      ) : null}
    </div>
  );
}

function ThoughtRow({ thought }: { thought: AgentThought }) {
  const color =
    thought.agent === "architect"
      ? "text-primary"
      : "text-foreground";
  return (
    <div className="flex items-baseline gap-2">
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {thought.agent}
      </span>
      {thought.toolName ? (
        <code className={"shrink-0 font-mono text-[11px] " + color}>
          {thought.toolName}
        </code>
      ) : thought.kind === "decision" ? (
        <Sparkles
          className="shrink-0 size-3 text-primary"
          aria-hidden
        />
      ) : null}
      <span className="text-xs leading-relaxed text-foreground">
        {thought.message}
      </span>
      <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
        {new Date(thought.at).toLocaleTimeString()}
      </span>
    </div>
  );
}
