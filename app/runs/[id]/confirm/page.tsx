import Link from "next/link";
import { notFound } from "next/navigation";

import { PlanConfirm } from "@/components/plan-confirm";
import { TopNav } from "@/components/top-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getRun } from "@/lib/run-store";

interface ConfirmPageProps {
  params: Promise<{ id: string }>;
}

export default async function ConfirmRunPage({ params }: ConfirmPageProps) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run || !run.plan) notFound();

  if (run.status === "running" || run.status === "succeeded" || run.status === "partial" || run.status === "failed") {
    return (
      <div className="flex min-h-full flex-1 flex-col">
        <TopNav current="runs" />
        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-10">
          <h1 className="text-xl font-semibold tracking-tight">
            This run is past the confirmation step
          </h1>
          <p className="text-sm text-muted-foreground">
            The plan for run{" "}
            <span className="font-mono text-foreground">{run.id}</span> has
            already been confirmed.
          </p>
          <Link href={`/runs/${run.id}`}>
            <Button>Open run progress</Button>
          </Link>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <TopNav current="runs" />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-10">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              Confirm plan
            </h1>
            <Badge variant="outline" className="font-mono text-xs">
              {run.id}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Schema parsed: {run.schemaTableCount} tables. Review the plan,
            its predicates, and the deterministic pre-run cost estimate
            before generation runs.
          </p>
        </div>

        <PlanConfirm
          runId={run.id}
          requestedVolume={run.requestedVolume}
          plan={run.plan}
        />
      </main>
    </div>
  );
}
