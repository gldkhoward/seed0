"use client";

import { useTransition } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cancelRunAction, confirmRunAction } from "@/lib/ui-actions";
import type { ScenarioPlan } from "@/lib/types";
import {
  estimateRunCost,
  formatPredicateExpr,
  formatUsd,
} from "@/lib/ui-types";

interface PlanConfirmProps {
  runId: string;
  requestedVolume: number;
  tableCount: number;
  plan: ScenarioPlan;
}

export function PlanConfirm({
  runId,
  requestedVolume,
  tableCount,
  plan,
}: PlanConfirmProps) {
  const [confirming, startConfirm] = useTransition();
  const [cancelling, startCancel] = useTransition();
  const cost = estimateRunCost(requestedVolume);
  const busy = confirming || cancelling;

  return (
    <div className="flex flex-col gap-8 pb-28">
      <Header runId={runId} />

      <StatRow
        tiles={[
          { label: "Tables", value: String(tableCount) },
          { label: "Scenarios", value: String(plan.scenarios.length) },
          { label: "Target rows", value: cost.rows.toLocaleString() },
          {
            label: "Est. total cost",
            value: formatUsd(cost.totalUsd),
            emphasized: true,
          },
        ]}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <ScenarioList scenarios={plan.scenarios} />
        <CostPanel cost={cost} />
      </div>

      <ActionBar
        runId={runId}
        confirming={confirming}
        cancelling={cancelling}
        busy={busy}
        onConfirm={() => startConfirm(() => confirmRunAction(runId))}
        onCancel={() => startCancel(() => cancelRunAction(runId))}
      />
    </div>
  );
}

// ---------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------

function Header({ runId }: { runId: string }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="secondary"
          className="gap-1.5 border border-primary/40 bg-primary/10 text-primary"
        >
          <span className="size-1.5 rounded-full bg-primary" aria-hidden />
          Awaiting confirmation
        </Badge>
        <Badge variant="outline" className="font-mono text-[10px]">
          {runId}
        </Badge>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">Confirm plan</h1>
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Each scenario carries a structured{" "}
        <span className="font-mono text-foreground">predicate</span> the
        deterministic evaluator will match against canonical rows after
        generation. The plan is not free-text editable — confirm to run,
        cancel to discard.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------
// Top stat tiles
// ---------------------------------------------------------------------

interface StatTile {
  label: string;
  value: string;
  emphasized?: boolean;
}

function StatRow({ tiles }: { tiles: StatTile[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map((t) => (
        <div
          key={t.label}
          className={
            "flex flex-col gap-1 rounded-md border px-4 py-3 transition-colors " +
            (t.emphasized
              ? "border-primary/40 bg-primary/5"
              : "border-border bg-card")
          }
        >
          <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
            {t.label}
          </span>
          <span
            className={
              "font-mono text-lg tabular-nums " +
              (t.emphasized ? "font-semibold text-primary" : "text-foreground")
            }
          >
            {t.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------
// Scenario list (dense rows in a single bordered container)
// ---------------------------------------------------------------------

function ScenarioList({
  scenarios,
}: {
  scenarios: ScenarioPlan["scenarios"];
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold tracking-tight">
          Scenarios ({scenarios.length})
        </h2>
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          predicate-bearing
        </span>
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-card">
        {scenarios.map((s, i) => (
          <div
            key={s.id}
            className="flex items-start gap-4 border-b border-border/60 px-4 py-4 last:border-b-0"
          >
            <span className="mt-0.5 font-mono text-xs tabular-nums text-muted-foreground">
              {String(i + 1).padStart(2, "0")}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-sm font-medium leading-tight text-foreground">
                  {s.name}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {s.id}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {s.description}
              </p>
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  WHERE
                </span>
                <code className="rounded border border-border/70 bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-foreground">
                  {s.predicate.table}
                </code>
                <span className="font-mono text-[10px] text-muted-foreground">
                  ·
                </span>
                <code className="rounded border border-border/70 bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-foreground">
                  {formatPredicateExpr(s.predicate.where)}
                </code>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------
// Cost panel (right sidebar on lg+, stacks under scenarios on smaller)
// ---------------------------------------------------------------------

function CostPanel({ cost }: { cost: ReturnType<typeof estimateRunCost> }) {
  return (
    <aside className="flex h-fit flex-col gap-4 rounded-md border border-border bg-card p-5 lg:sticky lg:top-6">
      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          Estimated total
        </span>
        <span className="font-mono text-3xl font-semibold tabular-nums text-foreground">
          {formatUsd(cost.totalUsd)}
        </span>
        <span className="text-[11px] text-muted-foreground">
          Deterministic arithmetic — not a predictive model.
        </span>
      </div>

      <div className="h-px bg-border" />

      <dl className="grid gap-2 font-mono text-[11px]">
        <CostLine
          label="Generation tokens"
          value={cost.generationTokens.toLocaleString()}
        />
        <CostLine
          label="Tokens / row"
          value={cost.tokensPerRow.toLocaleString()}
        />
        <CostLine
          label="Model price"
          value={`${formatUsd(cost.modelPricePerMTokens)} / 1M`}
        />
        <CostLine
          label="Generation cost"
          value={formatUsd(cost.generationUsd)}
        />
        <CostLine
          label="Planning cost"
          value={formatUsd(cost.planningUsd)}
        />
      </dl>
    </aside>
  );
}

function CostLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------
// Sticky action bar
// ---------------------------------------------------------------------

interface ActionBarProps {
  runId: string;
  confirming: boolean;
  cancelling: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ActionBar({
  confirming,
  cancelling,
  busy,
  onConfirm,
  onCancel,
}: ActionBarProps) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-6 py-3">
        <AlertDialog>
          <AlertDialogTrigger
            render={<Button variant="ghost" />}
            disabled={busy}
          >
            Cancel run
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel this run?</AlertDialogTitle>
              <AlertDialogDescription>
                The plan will be discarded and the run will close with a
                cancelled status. No generation will run.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={cancelling}
                onClick={onCancel}
              >
                {cancelling ? "Cancelling…" : "Cancel run"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Button size="lg" disabled={busy} onClick={onConfirm}>
          {confirming ? "Starting generation…" : "Confirm and generate"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Loading skeleton — matches the real layout to avoid jarring swap
// ---------------------------------------------------------------------

export function PlanConfirmSkeleton({ runId }: { runId: string }) {
  return (
    <div className="flex flex-col gap-8 pb-28">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="secondary"
            className="gap-1.5 border border-primary/40 bg-primary/10 text-primary"
          >
            <span
              className="size-1.5 animate-pulse rounded-full bg-primary"
              aria-hidden
            />
            Generating plan…
          </Badge>
          <Badge variant="outline" className="font-mono text-[10px]">
            {runId}
          </Badge>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Confirm plan</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The planner is producing scenarios with structured predicates for
          your schema and context. This page auto-refreshes every 1.5s — no
          need to reload.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-md border border-border bg-card px-4 py-3"
          >
            <div className="h-2 w-12 animate-pulse rounded bg-muted" />
            <div className="h-5 w-20 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <div className="h-3 w-32 animate-pulse rounded bg-muted" />
            <div className="h-3 w-24 animate-pulse rounded bg-muted" />
          </div>
          <div className="overflow-hidden rounded-md border border-border bg-card">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="flex items-start gap-4 border-b border-border/60 px-4 py-4 last:border-b-0"
              >
                <div className="h-3 w-4 animate-pulse rounded bg-muted" />
                <div className="flex flex-1 flex-col gap-2">
                  <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                  <div className="h-2 w-full animate-pulse rounded bg-muted/70" />
                  <div className="h-4 w-1/2 animate-pulse rounded bg-muted/60" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <aside className="flex h-fit flex-col gap-4 rounded-md border border-border bg-card p-5">
          <div className="flex flex-col gap-2">
            <div className="h-2 w-20 animate-pulse rounded bg-muted" />
            <div className="h-8 w-28 animate-pulse rounded bg-muted" />
            <div className="h-2 w-3/4 animate-pulse rounded bg-muted/70" />
          </div>
          <div className="h-px bg-border" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-baseline justify-between gap-3">
              <div className="h-2 w-24 animate-pulse rounded bg-muted/70" />
              <div className="h-2 w-16 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}
