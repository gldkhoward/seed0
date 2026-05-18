import Link from "next/link";
import { notFound } from "next/navigation";

import { ReadinessReport } from "@/components/readiness-report";
import { TopNav } from "@/components/top-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getRun } from "@/lib/run-store";
import type { RunStatus } from "@/lib/ui-types";

interface ReportPageProps {
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

export default async function ReportPage({ params }: ReportPageProps) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();

  const ready =
    run.status === "succeeded" ||
    run.status === "partial" ||
    run.status === "failed";

  if (!ready || !run.plan || !run.report) {
    return (
      <div className="flex min-h-full flex-1 flex-col">
        <TopNav current="runs" />
        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-10">
          <h1 className="text-2xl font-semibold tracking-tight">
            Report not ready
          </h1>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                This run hasn&apos;t produced a readiness report yet
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
              <p>
                Status:{" "}
                <Badge variant={STATUS_VARIANT[run.status]}>
                  {STATUS_LABEL[run.status]}
                </Badge>
              </p>
              <Link href={`/runs/${run.id}`}>
                <Button>Open progress</Button>
              </Link>
            </CardContent>
          </Card>
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
              Readiness report
            </h1>
            <Badge variant="outline" className="font-mono text-xs">
              {run.id}
            </Badge>
            <Badge variant={STATUS_VARIANT[run.status]}>
              {STATUS_LABEL[run.status]}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {run.schemaTableCount} tables · {run.requestedVolume.toLocaleString()} requested rows · completed{" "}
            <span className="font-mono text-foreground">
              {new Date(run.createdAt).toLocaleString()}
            </span>
          </p>
        </div>

        <ReadinessReport run={run} plan={run.plan} report={run.report} />

        <div className="flex items-center justify-between gap-2">
          <Link href="/runs">
            <Button variant="ghost">Back to history</Button>
          </Link>
          <Link href={`/runs/${run.id}`}>
            <Button variant="outline">View progress</Button>
          </Link>
        </div>
      </main>
    </div>
  );
}
