import { CircleAlert, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { RunProgress } from "@/components/run-progress";
import { TopNav } from "@/components/top-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getRun } from "@/lib/run-store";
import type { RunDetail, RunStatus } from "@/lib/ui-types";

interface RunPageProps {
  params: Promise<{ id: string }>;
}

const STATUS_LABEL: Record<RunStatus, string> = {
  pending_plan: "Planning",
  awaiting_confirmation: "Awaiting confirmation",
  running: "Running",
  cancelled: "Cancelled",
  succeeded: "Succeeded",
  partial: "Partial",
  failed: "Failed",
};

const STATUS_VARIANT: Record<RunStatus, "default" | "secondary" | "destructive" | "outline"> = {
  pending_plan: "secondary",
  awaiting_confirmation: "outline",
  running: "secondary",
  cancelled: "outline",
  succeeded: "default",
  partial: "outline",
  failed: "destructive",
};

export default async function RunPage({ params }: RunPageProps) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();

  const done = ["succeeded", "partial", "failed"].includes(run.status);

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <TopNav current="runs" />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-10">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              Run progress
            </h1>
            <Badge variant="outline" className="font-mono text-xs">
              {run.id}
            </Badge>
            <Badge variant={STATUS_VARIANT[run.status]}>
              {STATUS_LABEL[run.status]}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {run.schemaTableCount} tables · {run.requestedVolume.toLocaleString()} requested rows · started{" "}
            <span className="font-mono text-foreground">
              {new Date(run.createdAt).toLocaleString()}
            </span>
          </p>
        </div>

        <OutcomeBanner run={run} />

        <RunProgress run={run} />

        {done ? (
          <div className="flex items-center justify-end gap-2">
            <Link href="/runs">
              <Button variant="outline">Back to history</Button>
            </Link>
            <Link href={`/runs/${run.id}/report`}>
              <Button>View readiness report</Button>
            </Link>
          </div>
        ) : run.status === "awaiting_confirmation" ? (
          <div className="flex items-center justify-end gap-2">
            <Link href={`/runs/${run.id}/confirm`}>
              <Button>Confirm plan</Button>
            </Link>
          </div>
        ) : null}
      </main>
    </div>
  );
}

function OutcomeBanner({ run }: { run: RunDetail }) {
  if (run.status === "failed") {
    const failedStep = run.steps.find((s) => s.status === "failed");
    const error = failedStep?.details?.error ?? failedStep?.note;
    return (
      <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3">
        <CircleAlert
          className="mt-0.5 size-5 shrink-0 text-destructive"
          aria-hidden
        />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-destructive">
            Run failed at {failedStep ? failedStep.name : "an unknown step"}
          </p>
          {error ? (
            <p className="font-mono text-[11px] text-destructive/80">
              {String(error)}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Expand the failed step below to see the full error. To retry,
            start a new run with the same inputs from the history view.
          </p>
        </div>
      </div>
    );
  }
  if (run.status === "partial") {
    const passRate =
      run.constraintPassRate !== undefined
        ? `${Math.round(run.constraintPassRate * 100)}%`
        : "—";
    const coverage =
      run.scenariosInstantiated !== undefined &&
      run.scenariosPlanned !== undefined
        ? `${run.scenariosInstantiated}/${run.scenariosPlanned}`
        : "—";
    return (
      <div className="flex items-start gap-3 rounded-md border border-yellow-500/40 bg-yellow-500/5 px-4 py-3">
        <TriangleAlert
          className="mt-0.5 size-5 shrink-0 text-yellow-500"
          aria-hidden
        />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Run completed — partial</p>
          <p className="text-xs text-muted-foreground">
            Constraint pass rate{" "}
            <span className="font-mono text-foreground">{passRate}</span>,
            predicate coverage{" "}
            <span className="font-mono text-foreground">{coverage}</span>.
            Expand the validate / evaluate steps below to see what missed,
            or open the readiness report for the full breakdown.
          </p>
        </div>
      </div>
    );
  }
  return null;
}
