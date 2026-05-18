import Link from "next/link";
import { notFound } from "next/navigation";

import { RunProgress } from "@/components/run-progress";
import { TopNav } from "@/components/top-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getRun } from "@/lib/run-store";
import type { RunStatus } from "@/lib/ui-types";

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
