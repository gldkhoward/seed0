import Link from "next/link";
import { CheckCircle2, Download, XCircle } from "lucide-react";

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
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ReadinessReport, ScenarioPlan } from "@/lib/types";
import { formatPredicateExpr, type RunDetail } from "@/lib/ui-types";

interface ReadinessReportProps {
  run: RunDetail;
  plan: ScenarioPlan;
  report: ReadinessReport;
}

export function ReadinessReport({ run, plan, report }: ReadinessReportProps) {
  const instantiatedPct = Math.round(report.predicateCoverage * 100);
  const constraintPct = Math.round(report.constraintPassRate * 100);
  const scenariosInstantiated = report.scenarioResults.filter(
    (r) => r.instantiated,
  ).length;
  const failures = report.validation.failures;
  const hasFailures = failures.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Scenarios instantiated
            </CardTitle>
            <CardDescription>
              At least one canonical row satisfies the scenario&apos;s
              predicate.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Progress value={instantiatedPct} className="gap-2">
              <ProgressLabel className="font-mono text-xs">
                {scenariosInstantiated} / {plan.scenarios.length}
              </ProgressLabel>
              <ProgressValue className="font-mono text-xs" />
            </Progress>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Hard-constraint pass rate
            </CardTitle>
            <CardDescription>
              Required, FK, enum, check, unique, type — deterministic.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Progress value={constraintPct} className="gap-2">
              <ProgressLabel className="font-mono text-xs">
                {report.validation.passingRecords} /{" "}
                {report.validation.totalRecords}
              </ProgressLabel>
              <ProgressValue className="font-mono text-xs" />
            </Progress>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">
            Per-scenario predicate results
          </CardTitle>
          <CardDescription>
            Each scenario counts only if its structured predicate matched at
            least one canonical row.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {plan.scenarios.map((scenario, i) => {
            const result = report.scenarioResults.find(
              (r) => r.scenarioId === scenario.id,
            );
            const instantiated = result?.instantiated ?? false;
            return (
              <div
                key={scenario.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-border/70 bg-card/60 p-3"
              >
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="font-mono">
                      {String(i + 1).padStart(2, "0")} · {scenario.id}
                    </Badge>
                    <span className="text-sm font-medium">
                      {scenario.name}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="font-mono">
                      {scenario.predicate.table}
                    </Badge>
                    <Badge variant="secondary" className="font-mono text-[11px]">
                      {formatPredicateExpr(scenario.predicate.where)}
                    </Badge>
                  </div>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    matched rows: {result?.matchedRowCount ?? 0}
                  </p>
                </div>
                {instantiated ? (
                  <Badge variant="default" className="shrink-0">
                    <CheckCircle2 className="size-3" aria-hidden /> instantiated
                  </Badge>
                ) : (
                  <Badge variant="destructive" className="shrink-0">
                    <XCircle className="size-3" aria-hidden /> missing
                  </Badge>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">
            Unresolved failures
          </CardTitle>
          <CardDescription>
            Records that did not pass after the repair loop&apos;s retry cap.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hasFailures ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Table</TableHead>
                  <TableHead className="text-right">Row</TableHead>
                  <TableHead>Column</TableHead>
                  <TableHead>Constraint</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {failures.map((f, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-xs">
                      {f.table}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {f.rowIndex}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {f.column ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {f.constraint}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {f.detail}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">
              No unresolved failures. Every generated record satisfied the
              deterministic constraint check.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">
            Export the dataset
          </CardTitle>
          <CardDescription>
            JSON is the source of truth. The SQL export is derived from it,
            dependency-ordered, and ready to load into a Postgres database.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Link
            href={`/runs/${run.id}/export/json`}
            prefetch={false}
            download={`${run.id}.json`}
          >
            <Button variant="outline">
              <Download className="size-3.5" aria-hidden />
              Download JSON
            </Button>
          </Link>
          <Link
            href={`/runs/${run.id}/export/sql`}
            prefetch={false}
            download={`${run.id}.sql`}
          >
            <Button variant="outline">
              <Download className="size-3.5" aria-hidden />
              Download Postgres SQL
            </Button>
          </Link>
          {!run.canonicalDataset ? (
            <span className="text-xs text-muted-foreground">
              Dataset materializes after the run succeeds.
            </span>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
