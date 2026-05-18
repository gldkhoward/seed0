"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  Circle,
  CircleAlert,
  CircleDashed,
  Loader2,
  MinusCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import type { RunDetail, RunStep, StepStatus } from "@/lib/ui-types";

interface RunProgressProps {
  run: RunDetail;
}

const STEP_LABELS: Record<RunStep["name"], string> = {
  parse: "Parse schema",
  plan: "Plan scenarios",
  confirm: "Confirm plan",
  cache: "Cache decision",
  generate: "Generate seed data",
  validate: "Validate constraints",
  repair: "Repair invalid rows",
  "predicate-evaluate": "Evaluate predicates",
  score: "Score readiness",
  persist: "Persist to Blob",
};

const STEP_HINTS: Record<RunStep["name"], string> = {
  parse: "DDL → entity model via AST",
  plan: "AI proposes predicate-bearing scenarios",
  confirm: "User confirmed plan + cost estimate",
  cache: "Hash(canonical schema + plan) lookup",
  generate: "Structured output bound to schema + plan",
  validate: "Required, FK, enum, check, unique, type",
  repair: "Failed records → regenerate, bounded retry",
  "predicate-evaluate": "Predicate evaluator over canonical rows",
  score: "Predicate-instantiated + constraint pass rate",
  persist: "Run record + canonical dataset to Vercel Blob",
};

export function RunProgress({ run }: RunProgressProps) {
  const router = useRouter();
  const isLive =
    run.status !== "succeeded" &&
    run.status !== "partial" &&
    run.status !== "failed" &&
    run.status !== "cancelled";

  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => router.refresh(), 1000);
    return () => clearInterval(id);
  }, [isLive, router]);

  return (
    <Card>
      <CardContent className="flex flex-col gap-0 p-0">
        {run.steps.map((step, i) => (
          <div key={step.name} className="flex flex-col">
            <StepRow step={step} cacheHit={run.cacheHit} />
            {i < run.steps.length - 1 ? (
              <Separator className="opacity-60" />
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function StepRow({
  step,
  cacheHit,
}: {
  step: RunStep;
  cacheHit?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const showSkeleton = step.status === "running";
  const cacheNote =
    step.name === "cache"
      ? cacheHit === undefined
        ? null
        : cacheHit
          ? "Cache hit · skipping generation"
          : "Cache miss · running full generation"
      : null;
  const hasDetails =
    !!step.details && Object.keys(step.details).length > 0;
  const canExpand = hasDetails || step.status === "failed";

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => canExpand && setOpen((v) => !v)}
        disabled={!canExpand}
        className={
          "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors " +
          (canExpand
            ? "cursor-pointer hover:bg-muted/30"
            : "cursor-default")
        }
        aria-expanded={canExpand ? open : undefined}
      >
        <div className="mt-0.5">
          <StepIcon status={step.status} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              {STEP_LABELS[step.name]}
            </span>
            <StepBadge status={step.status} stepName={step.name} cacheHit={cacheHit} />
          </div>
          <p className="text-xs text-muted-foreground">{STEP_HINTS[step.name]}</p>
          {cacheNote ? (
            <p className="mt-1 font-mono text-[11px] text-primary">{cacheNote}</p>
          ) : null}
          {showSkeleton ? (
            <div className="mt-2 flex flex-col gap-1.5">
              <Skeleton className="h-2 w-44" />
              <Skeleton className="h-2 w-32" />
            </div>
          ) : null}
          {step.note ? (
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              {step.note}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {step.finishedAt ? (
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
        <div className="border-t border-border/60 bg-muted/20 px-4 py-3">
          <StepDetails step={step} />
        </div>
      ) : null}
    </div>
  );
}

// ---- Per-step details renderers ----

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
  if (scenarios.length === 0) return <Empty />;
  return (
    <ul className="flex flex-col gap-1.5">
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
  );
}

function GenerateDetails({ details }: { details: Record<string, unknown> }) {
  const chunked = Boolean(details.chunked);
  const totalRows = Number(details.totalRows ?? 0);
  const requested = Number(details.requestedVolume ?? 0);
  const rowsByTable = (details.rowsByTable ?? {}) as Record<string, number>;
  const allocations = (details.allocations ?? {}) as Record<string, number>;
  const tableProgress = (details.tableProgress ?? {}) as Record<string, number>;
  const stages = (details.stages ?? []) as string[][];
  const autoAllocatedKeys = (details.autoAllocatedKeys ?? {}) as Record<string, string>;
  const sample = details.sampleRow as
    | { table: string; row: Record<string, unknown> }
    | null
    | undefined;

  // Build a per-table table that fuses allocation, progress, and final counts.
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
        items={
          chunked
            ? [
                { label: "Rows generated", value: totalRows.toLocaleString() },
                { label: "Requested volume", value: requested.toLocaleString() },
                { label: "FK stages", value: String(stages.length) },
              ]
            : [
                { label: "Rows generated", value: totalRows.toLocaleString() },
                { label: "Requested volume", value: requested.toLocaleString() },
              ]
        }
      />

      {chunked && stages.length > 0 ? (
        <div>
          <DetailLabel>FK execution stages (parallel within stage)</DetailLabel>
          <div className="mt-1 flex flex-col gap-1">
            {stages.map((stage, i) => (
              <div
                key={i}
                className="flex items-center gap-2 rounded border border-border/60 bg-card px-2 py-1.5 font-mono text-[11px]"
              >
                <Badge variant="outline" className="font-mono text-[10px]">
                  stage {i + 1}
                </Badge>
                <div className="flex flex-wrap items-center gap-1">
                  {stage.map((tbl) => (
                    <code
                      key={tbl}
                      className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px]"
                    >
                      {tbl}
                    </code>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

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
  const attempts = Number(details.attempts ?? 0);
  const cap = Number(details.cap ?? 0);
  const unresolved = Number(details.unresolved ?? 0);
  return (
    <StatGrid
      items={[
        { label: "Attempts", value: `${attempts} / ${cap}` },
        { label: "Unresolved", value: unresolved.toLocaleString() },
      ]}
    />
  );
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
      return <Check className="size-4 text-primary" aria-hidden />;
    case "running":
      return (
        <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
      );
    case "failed":
      return <CircleAlert className="size-4 text-destructive" aria-hidden />;
    case "skipped":
      return (
        <MinusCircle className="size-4 text-muted-foreground" aria-hidden />
      );
    default:
      return (
        <CircleDashed
          className="size-4 text-muted-foreground/60"
          aria-hidden
        />
      );
  }
}

function StepBadge({
  status,
  stepName,
  cacheHit,
}: {
  status: StepStatus;
  stepName: RunStep["name"];
  cacheHit?: boolean;
}) {
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
      return (
        <Badge variant="outline" className="font-mono text-muted-foreground">
          <Circle className="size-2.5" aria-hidden /> pending
        </Badge>
      );
  }
}
