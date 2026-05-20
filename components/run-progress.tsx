"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleDashed,
  Loader2,
  MinusCircle,
  Sparkles,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { RunDetail, RunStep, StepStatus } from "@/lib/ui-types";

interface RunProgressProps {
  run: RunDetail;
}

const TERMINAL_STATUSES = new Set<RunDetail["status"]>([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);

const STEP_LABELS: Record<RunStep["name"], string> = {
  parse: "Parse schema",
  plan: "Architect plan",
  confirm: "Confirm plan",
  cache: "Cache decision",
  generate: "Generate seed data",
  validate: "Validate constraints",
  repair: "Repair invalid rows",
  "predicate-evaluate": "Evaluate predicates",
  "coverage-boost": "Coverage boost",
  score: "Score readiness",
  persist: "Persist to Blob",
};

const STEP_QUEUE_RATIONALE: Record<RunStep["name"], string> = {
  parse: "Next: read the DDL into an entity model.",
  plan: "Next: architect designs scenarios + execution plan.",
  confirm: "Next: pause for your approval on the plan and cost.",
  cache: "Next: agent decides whether to reuse a prior dataset.",
  generate: "Next: produce rows wave-by-wave per the architect's plan.",
  validate: "Next: check every row against your constraints.",
  repair: "Next: agent fixes failing rows with verified tools.",
  "predicate-evaluate": "Next: verify each scenario instantiated.",
  "coverage-boost": "Next: regenerate rows for uninstantiated scenarios.",
  score: "Next: combine constraint pass rate and coverage.",
  persist: "Next: write the dataset to Blob.",
};

export function RunProgress({ run: initialRun }: RunProgressProps) {
  const router = useRouter();
  const [run, setRun] = useState<RunDetail>(initialRun);
  const lastRefreshedStatus = useRef<RunDetail["status"]>(initialRun.status);
  const isLive = !TERMINAL_STATUSES.has(run.status);

  useEffect(() => {
    if (!isLive) return;
    const controller = new AbortController();
    let cancelled = false;
    // Reconnect the NDJSON stream when it drops (proxy idle timeouts and
    // transient network errors can close a long-lived run-progress
    // connection during a slow step). The events route either resumes the
    // workflow's writable or serves the latest stored snapshot once and
    // closes, so reopening eventually delivers the terminal snapshot that
    // unlocks the "View readiness report" button.
    void (async () => {
      let backoffMs = 1000;
      while (!cancelled) {
        await consumeRunSnapshots(initialRun.id, controller.signal, (next) => {
          setRun((prev) => mergeSnapshot(prev, next));
        });
        if (cancelled) break;
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 8000);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [initialRun.id, isLive]);

  useEffect(() => {
    if (run.status === lastRefreshedStatus.current) return;
    lastRefreshedStatus.current = run.status;
    router.refresh();
  }, [run.status, router]);

  const { activeSteps, queuedStep } = useMemo(
    () => splitVisibleSteps(run.steps, isLive),
    [run.steps, isLive],
  );

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-center justify-between gap-2 pb-1">
        <div className="flex items-center gap-2">
          <Sparkles className="size-3.5 text-primary" aria-hidden />
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Agent timeline
          </span>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          {activeSteps.length} step{activeSteps.length === 1 ? "" : "s"}
          {queuedStep ? " · 1 queued" : ""}
        </span>
      </header>

      <ol className="relative flex flex-col">
        {activeSteps.map((step, i) => (
          <TimelineItem
            key={step.name}
            step={step}
            cacheHit={run.cacheHit}
            isLast={i === activeSteps.length - 1 && !queuedStep}
            queued={false}
          />
        ))}
        {queuedStep ? (
          <TimelineItem
            key={`queue-${queuedStep.name}`}
            step={queuedStep}
            cacheHit={run.cacheHit}
            isLast
            queued
          />
        ) : null}
      </ol>

      {activeSteps.length === 0 && !queuedStep ? (
        <p className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-6 text-center font-mono text-xs text-muted-foreground">
          Waiting for the agent to start…
        </p>
      ) : null}
    </div>
  );
}

/**
 * Visible-step partition.
 *
 * - `activeSteps`: every step that has ever moved past `pending`. Sorted
 *   by the spec order (parse → … → persist) — i.e. the order in
 *   `run.steps`, which already matches `STEP_ORDER` in `run-store.ts`.
 * - `queuedStep`: while the run is live, the first remaining `pending`
 *   step is surfaced as a "next up" preview so the UI doesn't sit silent
 *   between transitions.
 *
 * On terminal runs we hide the queued step entirely (nothing else will
 * happen) and hide steps that never ran (pending or skipped-without-note),
 * so the historical view stays clean.
 */
function splitVisibleSteps(
  steps: readonly RunStep[],
  isLive: boolean,
): { activeSteps: RunStep[]; queuedStep: RunStep | undefined } {
  const active: RunStep[] = [];
  let queue: RunStep | undefined;
  for (const s of steps) {
    if (s.status === "pending") {
      if (isLive && !queue && hasAnyActive(steps)) queue = s;
      continue;
    }
    // On terminal runs, surface "skipped" only if it carries explanatory
    // detail (cache miss/hit, cancellation note). Otherwise hide.
    if (!isLive && s.status === "skipped" && !s.note && !s.details) continue;
    active.push(s);
  }
  // First step before any activity — show the very first pending step
  // as queued so the timeline isn't empty.
  if (active.length === 0 && isLive && !queue && steps.length > 0) {
    queue = steps[0];
  }
  return { activeSteps: active, queuedStep: queue };
}

function hasAnyActive(steps: readonly RunStep[]): boolean {
  return steps.some((s) => s.status !== "pending");
}

/**
 * Reads NDJSON snapshots from /runs/[id]/events. Each line is a complete
 * RunDetail JSON document.
 */
async function consumeRunSnapshots(
  runId: string,
  signal: AbortSignal,
  onSnapshot: (snapshot: RunDetail) => void,
): Promise<void> {
  try {
    const res = await fetch(`/runs/${runId}/events`, {
      signal,
      cache: "no-store",
    });
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          onSnapshot(JSON.parse(line) as RunDetail);
        } catch {
          // Malformed line — skip.
        }
      }
    }
  } catch {
    // Aborted on unmount or transient network error — silent.
  }
}

function mergeSnapshot(prev: RunDetail, next: RunDetail): RunDetail {
  if (prev.id !== next.id) return next;
  const prevTs = latestStepTimestamp(prev);
  const nextTs = latestStepTimestamp(next);
  if (prevTs && nextTs && nextTs < prevTs) return prev;
  return next;
}

function latestStepTimestamp(run: RunDetail): string | undefined {
  let latest: string | undefined;
  for (const step of run.steps) {
    const ts = step.finishedAt ?? step.startedAt;
    if (ts && (!latest || ts > latest)) latest = ts;
  }
  return latest;
}

// ---- Timeline item ----

function TimelineItem({
  step,
  cacheHit,
  isLast,
  queued,
}: {
  step: RunStep;
  cacheHit?: boolean;
  isLast: boolean;
  queued: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasDetails = !!step.details && Object.keys(step.details).length > 0;
  const canExpand = !queued && (hasDetails || step.status === "failed");
  const rationale = queued
    ? STEP_QUEUE_RATIONALE[step.name]
    : getStepRationale(step, cacheHit);

  return (
    <li
      className="relative flex animate-in fade-in-0 slide-in-from-bottom-2 duration-300 fill-mode-both"
      style={{ animationDelay: queued ? "120ms" : "0ms" }}
    >
      {/* Vertical connector */}
      {!isLast ? (
        <span
          aria-hidden
          className="absolute left-[15px] top-7 bottom-0 w-px bg-border"
        />
      ) : null}

      <div className="relative z-10 flex shrink-0 pt-1.5">
        <TimelineDot status={step.status} queued={queued} />
      </div>

      <div className="flex flex-1 flex-col pb-5 pl-3">
        <button
          type="button"
          onClick={() => canExpand && setOpen((v) => !v)}
          disabled={!canExpand}
          aria-expanded={canExpand ? open : undefined}
          className={
            "group flex w-full items-start justify-between gap-3 text-left " +
            (canExpand ? "cursor-pointer" : "cursor-default")
          }
        >
          <div className="flex flex-1 flex-col gap-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={
                  "text-sm font-medium " +
                  (queued ? "text-muted-foreground" : "text-foreground")
                }
              >
                {STEP_LABELS[step.name]}
              </span>
              <StepBadge
                status={step.status}
                stepName={step.name}
                cacheHit={cacheHit}
                queued={queued}
              />
            </div>
            <p
              className={
                "text-xs leading-relaxed " +
                (queued
                  ? "text-muted-foreground/80"
                  : step.status === "running"
                    ? "text-foreground"
                    : "text-muted-foreground")
              }
            >
              {rationale}
            </p>
            {step.note && !queued ? (
              <p className="font-mono text-[11px] text-muted-foreground">
                {step.note}
              </p>
            ) : null}
            {step.status === "running" ? (
              <div className="mt-1 flex flex-col gap-1.5">
                <Skeleton className="h-2 w-44" />
                <Skeleton className="h-2 w-32" />
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-0.5">
            {step.finishedAt && !queued ? (
              <span className="font-mono text-[11px] text-muted-foreground">
                {new Date(step.finishedAt).toLocaleTimeString()}
              </span>
            ) : null}
            {canExpand ? (
              <ChevronDown
                className={
                  "size-3.5 text-muted-foreground transition-transform " +
                  (open ? "rotate-180" : "")
                }
                aria-hidden
              />
            ) : null}
          </div>
        </button>

        {open && canExpand ? (
          <div className="mt-3 animate-in fade-in-0 slide-in-from-top-1 duration-200 rounded-lg border border-border/60 bg-muted/20 px-3 py-3">
            <StepDetails step={step} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

function TimelineDot({
  status,
  queued,
}: {
  status: StepStatus;
  queued: boolean;
}) {
  if (queued) {
    return (
      <span className="inline-flex size-[31px] items-center justify-center">
        <span className="relative inline-flex size-2.5 items-center justify-center">
          <span className="absolute inline-flex size-2.5 animate-ping rounded-full bg-primary/40" />
          <span className="relative inline-flex size-2 rounded-full border border-primary/40 bg-background" />
        </span>
      </span>
    );
  }
  return (
    <span
      className={
        "inline-flex size-[31px] items-center justify-center rounded-full border " +
        (status === "succeeded"
          ? "border-primary/40 bg-primary/10 text-primary"
          : status === "running"
            ? "border-primary/40 bg-primary/10 text-primary"
            : status === "failed"
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : status === "skipped"
                ? "border-border bg-muted text-muted-foreground"
                : "border-border bg-background text-muted-foreground/60")
      }
    >
      <StepIcon status={status} />
    </span>
  );
}

// ---- Rationale ----

function getStepRationale(step: RunStep, cacheHit?: boolean): string {
  const d = step.details ?? {};
  switch (step.name) {
    case "parse":
      if (step.status === "running") return "Reading your DDL into an entity model…";
      if (step.status === "succeeded") {
        const n = Array.isArray(d.tables) ? d.tables.length : 0;
        return `Parsed ${n} table${n === 1 ? "" : "s"} — schema accepted.`;
      }
      if (step.status === "failed")
        return "Parse rejected the schema — expand for the exact construct.";
      return "Schema parse queued.";

    case "plan":
      if (step.status === "running")
        return "Proposing coverage scenarios from your product context…";
      if (step.status === "succeeded") {
        const n = Number(d.scenarioCount ?? 0);
        return `Drafted ${n} scenario${n === 1 ? "" : "s"} for coverage.`;
      }
      if (step.status === "failed") return "Planner could not produce a usable plan.";
      return "Scenario planning queued.";

    case "confirm":
      if (step.status === "running") return "Holding for your approval on the plan and cost.";
      if (step.status === "succeeded") return "Approved — proceeding to generation.";
      if (step.status === "skipped") return "You cancelled — stopping here.";
      if (step.status === "failed") return "Confirmation step errored.";
      return "Awaiting your approval.";

    case "cache": {
      const decision = typeof d.decision === "string" ? d.decision : undefined;
      const reason = typeof d.reason === "string" ? d.reason : undefined;
      if (step.status === "running")
        return "Loading the agent's cache decision…";
      if (decision === "reuse") {
        const src =
          typeof d.sourceRunId === "string" ? d.sourceRunId.slice(0, 8) : "";
        return `Reusing cached dataset from ${src}${reason ? ` — ${reason}` : ""}`;
      }
      if (decision === "regenerate") {
        return reason ? `Regenerating — ${reason}` : "Regenerating fresh data.";
      }
      if (cacheHit === true) return "Cache hit — reusing the prior dataset.";
      if (cacheHit === false) return "Cache miss — running a full generation.";
      return "Cache check queued.";
    }

    case "generate": {
      if (step.status === "running") {
        const progress = d.tableProgress as Record<string, number> | undefined;
        const allocations = d.allocations as Record<string, number> | undefined;
        if (progress && allocations) {
          const done = Object.keys(progress).length;
          const total = Object.keys(allocations).length;
          const rows = Object.values(progress).reduce((a, b) => a + b, 0);
          return `Generating in FK order — ${done}/${total} tables, ${rows.toLocaleString()} rows so far.`;
        }
        return "Generating rows table-by-table in foreign-key order…";
      }
      if (step.status === "succeeded") {
        const rows = Number(d.totalRows ?? 0);
        const byTable = d.rowsByTable as Record<string, number> | undefined;
        const tableCount = byTable
          ? Object.values(byTable).filter((n) => n > 0).length
          : 0;
        return `Generated ${rows.toLocaleString()} rows across ${tableCount} table${tableCount === 1 ? "" : "s"}.`;
      }
      if (step.status === "failed") return "Generation failed — expand for details.";
      if (step.status === "skipped") return "Skipped — cache hit covered this.";
      return "Generation queued.";
    }

    case "validate": {
      if (step.status === "running") return "Checking every row against your constraints…";
      if (step.status === "succeeded") {
        const passing = Number(d.passingRecords ?? 0);
        const total = Number(d.totalRecords ?? 0);
        const failures = Number(d.failureCount ?? 0);
        if (failures === 0) return `All ${total.toLocaleString()} rows pass — no repair needed.`;
        return `${passing.toLocaleString()}/${total.toLocaleString()} pass · ${failures} failure${failures === 1 ? "" : "s"} flagged for repair.`;
      }
      if (step.status === "failed") return "Validation step errored.";
      return "Constraint check queued.";
    }

    case "repair": {
      if (step.status === "running") {
        const attempts = Number(d.attempts ?? 0);
        const cap = Number(d.cap ?? 0);
        return `Asking the model to fix failing rows · attempt ${attempts + 1}/${cap || "?"}.`;
      }
      if (step.status === "succeeded") {
        const attempts = Number(d.attempts ?? 0);
        if (attempts === 0) return "No repair needed — clean on first pass.";
        return `Cleared all failures after ${attempts} attempt${attempts === 1 ? "" : "s"}.`;
      }
      if (step.status === "failed") {
        const unresolved = Number(d.unresolved ?? 0);
        const attempts = Number(d.attempts ?? 0);
        return `${unresolved} row${unresolved === 1 ? "" : "s"} still failing after ${attempts} attempt${attempts === 1 ? "" : "s"} — accepting partial.`;
      }
      return "Repair queued.";
    }

    case "predicate-evaluate": {
      if (step.status === "running") return "Checking which scenarios actually instantiated…";
      if (step.status === "succeeded") {
        const inst = Number(d.instantiated ?? 0);
        const total = Number(d.total ?? 0);
        return `${inst}/${total} scenarios instantiated against canonical rows.`;
      }
      return "Coverage evaluation queued.";
    }

    case "coverage-boost": {
      if (step.status === "skipped") {
        const enabled = Boolean(d.enabled);
        return enabled
          ? "Skipped — no missing scenarios after the first pass."
          : "Skipped — architect did not enable coverage-boost.";
      }
      if (step.status === "running") {
        const missing = Array.isArray(d.missingScenarios)
          ? d.missingScenarios.length
          : 0;
        return `Regenerating rows for ${missing} missing scenario${missing === 1 ? "" : "s"}…`;
      }
      if (step.status === "succeeded") {
        const added = Number(d.totalAddedRows ?? 0);
        const tables = Array.isArray(d.perTable) ? d.perTable.length : 0;
        const inst = Number(d.instantiatedAfter ?? 0);
        const total = Number(d.totalScenarios ?? 0);
        return `Added ${added} row(s) across ${tables} table(s) — now ${inst}/${total} scenarios instantiated.`;
      }
      if (step.status === "failed") return "Coverage-boost errored.";
      return "Coverage-boost queued.";
    }

    case "score": {
      if (step.status === "running") return "Combining constraint pass rate and coverage…";
      if (step.status === "succeeded") {
        const cov = Number(d.predicateCoverage ?? 0);
        const con = Number(d.constraintPassRate ?? 0);
        return `Readiness scored — coverage ${(cov * 100).toFixed(0)}% · constraints ${(con * 100).toFixed(0)}%.`;
      }
      return "Scoring queued.";
    }

    case "persist": {
      if (step.status === "running") return "Writing the canonical dataset to Blob…";
      if (step.status === "succeeded") {
        const finalStatus = String(d.finalStatus ?? "");
        return `Persisted — final status: ${finalStatus}.`;
      }
      if (step.status === "failed") return "Persistence step errored.";
      return "Persist queued.";
    }
  }
}

// ---- Per-step detail renderers (unchanged) ----

function StepDetails({ step }: { step: RunStep }) {
  if (step.status === "failed" && step.details?.error) {
    return (
      <div className="flex flex-col gap-2">
        <DetailLabel>Error</DetailLabel>
        <pre className="overflow-x-auto rounded border border-destructive/30 bg-destructive/5 p-2 font-mono text-[11px] text-destructive">
          {String(step.details.error)}
        </pre>
      </div>
    );
  }
  switch (step.name) {
    case "parse":
      return <ParseDetails details={step.details ?? {}} />;
    case "plan":
      return <PlanDetails details={step.details ?? {}} />;
    case "generate":
      return <GenerateDetails details={step.details ?? {}} />;
    case "validate":
      return <ValidateDetails details={step.details ?? {}} />;
    case "repair":
      return <RepairDetails details={step.details ?? {}} />;
    case "predicate-evaluate":
      return <PredicateDetails details={step.details ?? {}} />;
    case "cache":
      return <CacheDetails details={step.details ?? {}} />;
    case "coverage-boost":
      return <CoverageBoostDetails details={step.details ?? {}} />;
    case "score":
      return <ScoreDetails details={step.details ?? {}} />;
    case "persist":
      return <PersistDetails details={step.details ?? {}} />;
    default:
      return <RawDetails details={step.details ?? {}} />;
  }
}

function ParseDetails({ details }: { details: Record<string, unknown> }) {
  const tables = (details.tables ?? []) as Array<{
    name: string;
    columns: number;
    foreignKeys: number;
    uniques: number;
    enums: number;
    checks: number;
  }>;
  if (tables.length === 0) return <Empty />;
  return (
    <div className="overflow-x-auto rounded border border-border/60 bg-card">
      <table className="min-w-full font-mono text-[11px]">
        <thead className="border-b border-border/60 text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 text-left">Table</th>
            <th className="px-2 py-1.5 text-right">Cols</th>
            <th className="px-2 py-1.5 text-right">FKs</th>
            <th className="px-2 py-1.5 text-right">Unique</th>
            <th className="px-2 py-1.5 text-right">Enums</th>
            <th className="px-2 py-1.5 text-right">Checks</th>
          </tr>
        </thead>
        <tbody>
          {tables.map((t) => (
            <tr key={t.name} className="border-b border-border/40 last:border-b-0">
              <td className="px-2 py-1.5">{t.name}</td>
              <td className="px-2 py-1.5 text-right">{t.columns}</td>
              <td className="px-2 py-1.5 text-right">{t.foreignKeys}</td>
              <td className="px-2 py-1.5 text-right">{t.uniques}</td>
              <td className="px-2 py-1.5 text-right">{t.enums}</td>
              <td className="px-2 py-1.5 text-right">{t.checks}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlanDetails({ details }: { details: Record<string, unknown> }) {
  const scenarios = (details.scenarios ?? []) as Array<{
    id: string;
    name: string;
    table: string;
  }>;
  const reasoning =
    typeof details.reasoning === "string" ? details.reasoning : "";
  const executionPlan = details.executionPlan as
    | {
        parallelGroups?: readonly (readonly string[])[];
        tableAllocations?: Record<string, number>;
        optionalSteps?: readonly string[];
        cacheDecision?:
          | { kind: "reuse"; sourceRunId: string; reason: string }
          | { kind: "regenerate"; reason: string };
      }
    | undefined;
  const isFallback = Boolean(details.fallback);
  const toolCallCount = Number(details.toolCallCount ?? 0);

  return (
    <div className="flex flex-col gap-3">
      {reasoning ? (
        <div className="rounded border border-border/60 bg-card px-2 py-1.5">
          <DetailLabel>
            Architect reasoning{isFallback ? " (fallback)" : ""}
          </DetailLabel>
          <p className="mt-1 text-xs leading-relaxed text-foreground">
            {reasoning}
          </p>
        </div>
      ) : null}

      {executionPlan ? (
        <div className="flex flex-col gap-2">
          <DetailLabel>Execution plan</DetailLabel>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            <div className="rounded border border-border/60 bg-card px-2 py-1.5">
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
                Waves
              </div>
              <div className="font-mono text-xs text-foreground">
                {executionPlan.parallelGroups?.length ?? 0}
              </div>
            </div>
            <div className="rounded border border-border/60 bg-card px-2 py-1.5">
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
                Cache
              </div>
              <div className="font-mono text-xs text-foreground">
                {executionPlan.cacheDecision?.kind ?? "—"}
              </div>
            </div>
            <div className="rounded border border-border/60 bg-card px-2 py-1.5">
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
                Tool calls
              </div>
              <div className="font-mono text-xs text-foreground">
                {toolCallCount}
              </div>
            </div>
          </div>
          {executionPlan.parallelGroups?.length ? (
            <div>
              <DetailLabel>Parallel waves</DetailLabel>
              <ol className="mt-1 flex flex-col gap-1">
                {executionPlan.parallelGroups.map((wave, i) => (
                  <li
                    key={i}
                    className="flex items-baseline gap-2 rounded border border-border/60 bg-card px-2 py-1 font-mono text-[11px]"
                  >
                    <span className="text-muted-foreground">
                      wave {i + 1}
                    </span>
                    <span className="text-foreground">
                      {wave.join(", ")}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {executionPlan.optionalSteps && executionPlan.optionalSteps.length > 0 ? (
            <div className="flex items-baseline gap-2">
              <DetailLabel>Optional steps</DetailLabel>
              <span className="font-mono text-[11px] text-foreground">
                {executionPlan.optionalSteps.join(", ")}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {scenarios.length > 0 ? (
        <div>
          <DetailLabel>Scenarios</DetailLabel>
          <ul className="mt-1 flex flex-col gap-1.5">
            {scenarios.map((s) => (
              <li
                key={s.id}
                className="flex items-baseline gap-2 font-mono text-[11px]"
              >
                <Badge variant="outline" className="font-mono text-[10px]">
                  {s.table}
                </Badge>
                <span className="text-foreground">{s.name}</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">{s.id}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function CacheDetails({ details }: { details: Record<string, unknown> }) {
  const decision = String(details.decision ?? "");
  const reason = typeof details.reason === "string" ? details.reason : "";
  const sourceRunId = typeof details.sourceRunId === "string"
    ? details.sourceRunId
    : undefined;
  const totalRows = Number(details.totalRows ?? 0);
  const tableRowCounts = (details.tableRowCounts ?? {}) as Record<string, number>;
  return (
    <div className="flex flex-col gap-3">
      <StatGrid
        items={[
          { label: "Decision", value: decision || "—" },
          ...(sourceRunId
            ? [{ label: "Source run", value: sourceRunId.slice(0, 12) }]
            : []),
          ...(totalRows
            ? [{ label: "Cached rows", value: totalRows.toLocaleString() }]
            : []),
        ]}
      />
      {reason ? (
        <div className="rounded border border-border/60 bg-card px-2 py-1.5">
          <DetailLabel>Reasoning</DetailLabel>
          <p className="mt-1 text-xs leading-relaxed text-foreground">{reason}</p>
        </div>
      ) : null}
      {decision === "reuse" && Object.keys(tableRowCounts).length > 0 ? (
        <KeyValueTable
          label="Reused rows per table"
          rows={Object.entries(tableRowCounts).sort((a, b) => b[1] - a[1])}
        />
      ) : null}
    </div>
  );
}

function CoverageBoostDetails({ details }: { details: Record<string, unknown> }) {
  const enabled = Boolean(details.enabled);
  if (!enabled) {
    return (
      <p className="font-mono text-[11px] text-muted-foreground">
        Coverage-boost was not enabled in the architect&apos;s plan.
      </p>
    );
  }
  const perTable = (details.perTable ?? []) as Array<{
    table: string;
    addedRows: number;
    scenarioIds: readonly string[];
  }>;
  const total = Number(details.totalAddedRows ?? 0);
  const instAfter = Number(details.instantiatedAfter ?? 0);
  const totalScenarios = Number(details.totalScenarios ?? 0);
  const missingBefore = (details.missingScenariosBefore ?? []) as string[];
  return (
    <div className="flex flex-col gap-3">
      <StatGrid
        items={[
          { label: "Rows added", value: total.toLocaleString() },
          { label: "Tables boosted", value: String(perTable.length) },
          {
            label: "Coverage after",
            value: `${instAfter}/${totalScenarios}`,
          },
        ]}
      />
      {missingBefore.length > 0 ? (
        <div>
          <DetailLabel>Missing scenarios before boost</DetailLabel>
          <ul className="mt-1 flex flex-col gap-1">
            {missingBefore.map((id) => (
              <li
                key={id}
                className="rounded border border-border/60 bg-card px-2 py-1 font-mono text-[11px]"
              >
                {id}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {perTable.length > 0 ? (
        <div>
          <DetailLabel>Per-table additions</DetailLabel>
          <ul className="mt-1 flex flex-col gap-1">
            {perTable.map((t) => (
              <li
                key={t.table}
                className="flex items-baseline justify-between rounded border border-border/60 bg-card px-2 py-1 font-mono text-[11px]"
              >
                <span className="text-foreground">{t.table}</span>
                <span className="text-muted-foreground">
                  +{t.addedRows} · {t.scenarioIds.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function GenerateDetails({ details }: { details: Record<string, unknown> }) {
  const chunked = Boolean(details.chunked);
  const requested = Number(details.requestedVolume ?? 0);
  const rowsByTable = (details.rowsByTable ?? {}) as Record<string, number>;
  const allocations = (details.allocations ?? {}) as Record<string, number>;
  const tableProgress = (details.tableProgress ?? {}) as Record<string, number>;
  const autoAllocatedKeys = (details.autoAllocatedKeys ?? {}) as Record<string, string>;
  const sample = details.sampleRow as
    | { table: string; row: Record<string, unknown> }
    | null
    | undefined;
  // The workflow only sets `totalRows` on the final succeeded payload.
  // While the step is running, derive the headline from live per-table
  // progress so it ticks alongside the per-table "Done" column.
  const totalRows =
    details.totalRows !== undefined
      ? Number(details.totalRows)
      : Object.values(tableProgress).reduce((a, b) => a + b, 0);

  const tableNames = Array.from(
    new Set([
      ...Object.keys(allocations),
      ...Object.keys(rowsByTable),
      ...Object.keys(tableProgress),
    ]),
  );

  return (
    <div className="flex flex-col gap-3">
      <StatGrid
        items={[
          { label: "Rows generated", value: totalRows.toLocaleString() },
          { label: "Requested volume", value: requested.toLocaleString() },
          chunked
            ? {
                label: "Tables",
                value: String(Object.keys(allocations).length),
              }
            : { label: "Mode", value: "single-call" },
        ]}
      />

      {chunked && tableNames.length > 0 ? (
        <div>
          <DetailLabel>Per-table allocation and progress</DetailLabel>
          <div className="mt-1 overflow-x-auto rounded border border-border/60 bg-card">
            <table className="min-w-full font-mono text-[11px]">
              <thead className="border-b border-border/60 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left">Table</th>
                  <th className="px-2 py-1.5 text-right">Allocated</th>
                  <th className="px-2 py-1.5 text-right">Done</th>
                  <th className="px-2 py-1.5 text-right">Final</th>
                  <th className="px-2 py-1.5 text-left">PK pre-allocated</th>
                </tr>
              </thead>
              <tbody>
                {tableNames.map((t) => {
                  const alloc = allocations[t] ?? 0;
                  const prog = tableProgress[t];
                  const final = rowsByTable[t];
                  const pk = autoAllocatedKeys[t];
                  return (
                    <tr
                      key={t}
                      className="border-b border-border/40 last:border-b-0"
                    >
                      <td className="px-2 py-1.5">{t}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {alloc.toLocaleString()}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                        {prog === undefined ? "—" : prog.toLocaleString()}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {final === undefined ? "—" : final.toLocaleString()}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        {pk ?? "model"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : Object.keys(rowsByTable).length > 0 ? (
        <KeyValueTable
          label="Rows per table"
          rows={Object.entries(rowsByTable).sort((a, b) => b[1] - a[1])}
        />
      ) : null}

      {sample ? (
        <div>
          <DetailLabel>Sample row · {sample.table}</DetailLabel>
          <pre className="mt-1 overflow-x-auto rounded border border-border/60 bg-card p-2 font-mono text-[11px] text-foreground">
            {JSON.stringify(sample.row, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function ValidateDetails({ details }: { details: Record<string, unknown> }) {
  const total = Number(details.totalRecords ?? 0);
  const passing = Number(details.passingRecords ?? 0);
  const passRate = Number(details.passRate ?? 0);
  const failureCount = Number(details.failureCount ?? 0);
  const byConstraint = (details.failuresByConstraint ?? {}) as Record<string, number>;
  const byTable = (details.failuresByTable ?? {}) as Record<string, number>;
  const samples = (details.sampleFailures ?? []) as Array<{
    table: string;
    rowIndex: number;
    column: string | null;
    constraint: string;
    detail: string;
  }>;
  return (
    <div className="flex flex-col gap-3">
      <StatGrid
        items={[
          { label: "Passing / Total", value: `${passing.toLocaleString()} / ${total.toLocaleString()}` },
          { label: "Pass rate", value: `${(passRate * 100).toFixed(1)}%` },
          { label: "Failures", value: failureCount.toLocaleString() },
        ]}
      />
      {Object.keys(byConstraint).length > 0 ? (
        <KeyValueTable
          label="Failures by constraint"
          rows={Object.entries(byConstraint).sort((a, b) => b[1] - a[1])}
        />
      ) : null}
      {Object.keys(byTable).length > 0 ? (
        <KeyValueTable
          label="Failures by table"
          rows={Object.entries(byTable).sort((a, b) => b[1] - a[1])}
        />
      ) : null}
      {samples.length > 0 ? (
        <div>
          <DetailLabel>Sample failures (first {samples.length})</DetailLabel>
          <ul className="mt-1 flex flex-col gap-1">
            {samples.map((f, i) => (
              <li
                key={i}
                className="rounded border border-border/60 bg-card px-2 py-1.5 font-mono text-[11px]"
              >
                <span className="text-muted-foreground">[{f.constraint}]</span>{" "}
                <span className="text-foreground">{f.table}</span>
                <span className="text-muted-foreground">
                  [{f.rowIndex}]{f.column ? `.${f.column}` : ""}
                </span>
                <span className="text-muted-foreground"> — </span>
                <span className="text-foreground">{f.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function RepairDetails({ details }: { details: Record<string, unknown> }) {
  const initial = Number(details.initialFailures ?? 0);
  const remaining = Number(details.finalFailures ?? initial);
  const cleared = Number(details.cleared ?? Math.max(0, initial - remaining));
  const stopped = (details.stoppedReason as string | undefined) ?? "running";
  const toolCalls = (details.toolCalls ?? []) as RepairToolCall[];

  return (
    <div className="flex flex-col gap-3">
      <StatGrid
        items={[
          { label: "Failures in", value: initial.toLocaleString() },
          { label: "Cleared", value: cleared.toLocaleString() },
          { label: "Remaining", value: remaining.toLocaleString() },
          { label: "Tool calls", value: String(toolCalls.length) },
          { label: "Stopped", value: stopped },
        ]}
      />
      {toolCalls.length > 0 ? (
        <ToolCallTrace calls={toolCalls} />
      ) : (
        <p className="font-mono text-[11px] text-muted-foreground">
          Agent has not made any tool calls yet.
        </p>
      )}
    </div>
  );
}

interface RepairToolCall {
  name: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  at?: string;
  ok?: boolean;
}

function ToolCallTrace({ calls }: { calls: readonly RepairToolCall[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <DetailLabel>Agent tool calls ({calls.length})</DetailLabel>
      <ol className="flex flex-col gap-1">
        {calls.map((call, i) => (
          <li
            key={`${call.name}-${call.at ?? i}`}
            className="flex flex-col gap-1 rounded border border-border/60 bg-card px-2 py-1.5"
          >
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <code
                  className={
                    "font-mono text-[11px] " +
                    (call.ok === false ? "text-destructive" : "text-foreground")
                  }
                >
                  {call.name}
                </code>
                <span className="font-mono text-[11px] text-muted-foreground">
                  ({summariseArgs(call.args)})
                </span>
              </div>
              {call.at ? (
                <span className="font-mono text-[10px] text-muted-foreground">
                  {new Date(call.at).toLocaleTimeString()}
                </span>
              ) : null}
            </div>
            <span className="font-mono text-[11px] text-muted-foreground">
              → {summariseResult(call.name, call.result)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function summariseArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return "—";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (Array.isArray(v)) {
      parts.push(`${k}=[${v.join(",")}]`);
    } else if (typeof v === "object" && v !== null) {
      parts.push(`${k}=${JSON.stringify(v)}`);
    } else {
      parts.push(`${k}=${String(v)}`);
    }
  }
  return parts.join(", ");
}

function summariseResult(
  name: string,
  result: Record<string, unknown> | undefined,
): string {
  if (!result) return "(no result)";
  if ("error" in result && typeof result.error === "string") {
    return `error: ${result.error}`;
  }
  switch (name) {
    case "listFailures": {
      const total = result.totalFailures as number | undefined;
      return `${total ?? 0} failure(s) remaining`;
    }
    case "getFkPool": {
      const count = result.count as number | undefined;
      return `${count ?? 0} valid values`;
    }
    case "getUnusedFkPairs": {
      const r = result.remaining as number | undefined;
      return `${r ?? 0} unused pair(s)`;
    }
    case "replaceRow": {
      const ok = result.ok as boolean | undefined;
      const total = result.totalFailures as number | undefined;
      return ok
        ? `row clean · ${total ?? 0} total remaining`
        : `row still failing · ${total ?? 0} total remaining`;
    }
    case "deterministicFix": {
      const ok = result.ok as boolean | undefined;
      const applied = result.applied as string | undefined;
      const detail = result.detail as string | undefined;
      const total = result.totalFailures as number | undefined;
      return ok
        ? `applied ${applied ?? "fix"} · ${detail ?? ""} · ${total ?? 0} remaining`
        : `failed · ${detail ?? "no strategy"}`;
    }
    case "bulkDeterministicFix": {
      const matched = Number(result.matched ?? 0);
      const fixed = Number(result.fixed ?? 0);
      const total = Number(result.totalFailures ?? 0);
      const byApplied = result.byApplied as
        | Record<string, number>
        | undefined;
      const breakdown =
        byApplied && Object.keys(byApplied).length > 0
          ? Object.entries(byApplied)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")
          : "—";
      return `fixed ${fixed}/${matched} (${breakdown}) · ${total} remaining`;
    }
    case "finish": {
      const reason = result.reason as string | undefined;
      const total = result.totalFailures as number | undefined;
      return `${reason ?? "done"} · ${total ?? 0} remaining`;
    }
  }
  return JSON.stringify(result);
}

function PredicateDetails({ details }: { details: Record<string, unknown> }) {
  const total = Number(details.total ?? 0);
  const instantiated = Number(details.instantiated ?? 0);
  const results = (details.results ?? []) as Array<{
    scenarioId: string;
    instantiated: boolean;
    matchedRowCount: number;
  }>;
  return (
    <div className="flex flex-col gap-3">
      <StatGrid
        items={[
          { label: "Instantiated", value: `${instantiated} / ${total}` },
          { label: "Coverage", value: `${total === 0 ? 0 : Math.round((instantiated / total) * 100)}%` },
        ]}
      />
      {results.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {results.map((r) => (
            <li
              key={r.scenarioId}
              className="flex items-center justify-between rounded border border-border/60 bg-card px-2 py-1.5 font-mono text-[11px]"
            >
              <span className="flex items-center gap-2 truncate">
                {r.instantiated ? (
                  <Check className="size-3 text-primary" aria-hidden />
                ) : (
                  <CircleAlert
                    className="size-3 text-muted-foreground"
                    aria-hidden
                  />
                )}
                <span
                  className={
                    r.instantiated
                      ? "text-foreground"
                      : "text-muted-foreground"
                  }
                >
                  {r.scenarioId}
                </span>
              </span>
              <span className="text-muted-foreground">
                {r.matchedRowCount} match{r.matchedRowCount === 1 ? "" : "es"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ScoreDetails({ details }: { details: Record<string, unknown> }) {
  const constraintPassRate = Number(details.constraintPassRate ?? 0);
  const predicateCoverage = Number(details.predicateCoverage ?? 0);
  return (
    <StatGrid
      items={[
        { label: "Constraint pass rate", value: `${(constraintPassRate * 100).toFixed(1)}%` },
        { label: "Predicate coverage", value: `${(predicateCoverage * 100).toFixed(1)}%` },
      ]}
    />
  );
}

function PersistDetails({ details }: { details: Record<string, unknown> }) {
  const totalRows = Number(details.totalRows ?? 0);
  const tableCount = Number(details.tableCount ?? 0);
  const finalStatus = String(details.finalStatus ?? "");
  return (
    <StatGrid
      items={[
        { label: "Total rows", value: totalRows.toLocaleString() },
        { label: "Tables", value: String(tableCount) },
        { label: "Final status", value: finalStatus },
      ]}
    />
  );
}

function RawDetails({ details }: { details: Record<string, unknown> }) {
  if (Object.keys(details).length === 0) return <Empty />;
  return (
    <pre className="overflow-x-auto rounded border border-border/60 bg-card p-2 font-mono text-[11px] text-foreground">
      {JSON.stringify(details, null, 2)}
    </pre>
  );
}

// ---- Tiny shared bits ----

function StatGrid({
  items,
}: {
  items: Array<{ label: string; value: string }>;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
      {items.map((it) => (
        <div
          key={it.label}
          className="rounded border border-border/60 bg-card px-2 py-1.5"
        >
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
            {it.label}
          </div>
          <div className="font-mono text-xs text-foreground">{it.value}</div>
        </div>
      ))}
    </div>
  );
}

function KeyValueTable({
  label,
  rows,
}: {
  label: string;
  rows: Array<[string, number | string]>;
}) {
  return (
    <div>
      <DetailLabel>{label}</DetailLabel>
      <div className="mt-1 overflow-hidden rounded border border-border/60 bg-card">
        {rows.map(([k, v], i) => (
          <div
            key={k}
            className={
              "flex items-center justify-between px-2 py-1 font-mono text-[11px] " +
              (i < rows.length - 1 ? "border-b border-border/40" : "")
            }
          >
            <span className="text-foreground">{k}</span>
            <span className="text-muted-foreground tabular-nums">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DetailLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

function Empty() {
  return (
    <p className="font-mono text-[11px] text-muted-foreground">
      no details available
    </p>
  );
}

function StepIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "succeeded":
      return <Check className="size-3.5" aria-hidden />;
    case "running":
      return <Loader2 className="size-3.5 animate-spin" aria-hidden />;
    case "failed":
      return <CircleAlert className="size-3.5" aria-hidden />;
    case "skipped":
      return <MinusCircle className="size-3.5" aria-hidden />;
    default:
      return <CircleDashed className="size-3.5" aria-hidden />;
  }
}

function StepBadge({
  status,
  stepName,
  cacheHit,
  queued,
}: {
  status: StepStatus;
  stepName: RunStep["name"];
  cacheHit?: boolean;
  queued: boolean;
}) {
  if (queued) {
    return (
      <Badge variant="outline" className="font-mono text-muted-foreground">
        queued
      </Badge>
    );
  }
  if (stepName === "cache" && cacheHit !== undefined) {
    return (
      <Badge variant={cacheHit ? "default" : "outline"} className="font-mono">
        {cacheHit ? "hit" : "miss"}
      </Badge>
    );
  }
  switch (status) {
    case "succeeded":
      return (
        <Badge variant="default" className="font-mono">
          done
        </Badge>
      );
    case "running":
      return (
        <Badge variant="secondary" className="font-mono">
          running
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className="font-mono">
          failed
        </Badge>
      );
    case "skipped":
      return (
        <Badge variant="outline" className="font-mono">
          skipped
        </Badge>
      );
    default:
      return null;
  }
}
