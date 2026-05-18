import Link from "next/link";
import { notFound } from "next/navigation";

import { AutoRefresh } from "@/components/auto-refresh";
import { PlanConfirm, PlanConfirmSkeleton } from "@/components/plan-confirm";
import { TopNav } from "@/components/top-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getRun } from "@/lib/run-store";
import type { RunStatus } from "@/lib/ui-types";

interface ConfirmPageProps {
  params: Promise<{ id: string }>;
}

const PAST_STATUSES: ReadonlySet<RunStatus> = new Set([
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);

export default async function ConfirmRunPage({ params }: ConfirmPageProps) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();

  if (PAST_STATUSES.has(run.status)) {
    return (
      <PageShell>
        <PastConfirmationView runId={run.id} status={run.status} />
      </PageShell>
    );
  }

  if (!run.plan) {
    return (
      <PageShell>
        <AutoRefresh intervalMs={1500} />
        <PlanConfirmSkeleton runId={run.id} />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PlanConfirm
        runId={run.id}
        requestedVolume={run.requestedVolume}
        tableCount={run.schemaTableCount}
        plan={run.plan}
      />
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <TopNav current="runs" />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-8">
        {children}
      </main>
    </div>
  );
}

function PastConfirmationView({
  runId,
  status,
}: {
  runId: string;
  status: RunStatus;
}) {
  const label =
    status === "running"
      ? "Generation in progress"
      : status === "succeeded"
        ? "Run completed"
        : status === "partial"
          ? "Run completed with unresolved failures"
          : status === "failed"
            ? "Run failed"
            : "Run cancelled";

  const cta =
    status === "succeeded" || status === "partial" || status === "failed"
      ? { href: `/runs/${runId}/report`, label: "View readiness report" }
      : { href: `/runs/${runId}`, label: "Open run progress" };

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[10px]">
          {runId}
        </Badge>
        <Badge variant="secondary">{label}</Badge>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">
        Past the confirmation step
      </h1>
      <p className="text-sm leading-relaxed text-muted-foreground">
        This run has already moved beyond plan confirmation. There&apos;s
        nothing more to confirm here.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={cta.href}>
          <Button>{cta.label}</Button>
        </Link>
        <Link href="/runs">
          <Button variant="ghost">Back to history</Button>
        </Link>
      </div>
    </div>
  );
}
