import Link from "next/link";

import { RunRowActions } from "@/components/run-row-actions";
import { TopNav } from "@/components/top-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listRuns } from "@/lib/run-store";
import type { RunStatus } from "@/lib/ui-types";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<RunStatus, string> = {
  pending_plan: "Planning",
  awaiting_confirmation: "Awaiting",
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

export default async function RunsHistoryPage() {
  const runs = await listRuns();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <TopNav current="runs" />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
            <p className="text-sm text-muted-foreground">
              Past runs derived from Vercel Blob prefix listing, ordered by
              recency.
            </p>
          </div>
          <Link href="/new">
            <Button>New run</Button>
          </Link>
        </div>

        <Card>
          <CardHeader className="gap-2">
            <CardTitle className="text-base font-semibold">History</CardTitle>
            <CardDescription>
              Re-run a row with a new volume to exercise the cache
              scale-down / scale-up path.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {runs.length === 0 ? (
              <p className="px-6 py-10 text-center text-sm text-muted-foreground">
                No runs yet.{" "}
                <Link
                  href="/new"
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  Start your first run
                </Link>
                .
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Run</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead className="text-right">Tables</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead>Cache</TableHead>
                    <TableHead>Scenarios</TableHead>
                    <TableHead className="text-right">Constraints</TableHead>
                    <TableHead className="pr-6 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((run) => {
                    const reportable =
                      run.status === "succeeded" ||
                      run.status === "partial" ||
                      run.status === "failed";
                    return (
                      <TableRow key={run.id}>
                        <TableCell className="pl-6 font-mono text-xs">
                          {reportable ? (
                            <Link
                              href={`/runs/${run.id}/report`}
                              className="underline-offset-4 hover:underline"
                            >
                              {run.id}
                            </Link>
                          ) : (
                            <Link
                              href={`/runs/${run.id}`}
                              className="underline-offset-4 hover:underline"
                            >
                              {run.id}
                            </Link>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[run.status]}>
                            {STATUS_LABEL[run.status]}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {new Date(run.createdAt).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {run.schemaTableCount}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {run.requestedVolume.toLocaleString()}
                        </TableCell>
                        <TableCell>
                          {run.cacheHit === undefined ? (
                            <span className="font-mono text-xs text-muted-foreground">
                              —
                            </span>
                          ) : (
                            <Badge
                              variant={run.cacheHit ? "default" : "outline"}
                              className="font-mono"
                            >
                              {run.cacheHit ? "hit" : "miss"}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {run.scenariosInstantiated !== undefined &&
                          run.scenariosPlanned !== undefined
                            ? `${run.scenariosInstantiated} / ${run.scenariosPlanned}`
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {run.constraintPassRate !== undefined
                            ? `${Math.round(run.constraintPassRate * 100)}%`
                            : "—"}
                        </TableCell>
                        <TableCell className="pr-6 text-right">
                          <RunRowActions
                            runId={run.id}
                            defaultVolume={run.requestedVolume}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
