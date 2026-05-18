"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
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
    run.status === "running" || run.status === "awaiting_confirmation";

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
  const showSkeleton = step.status === "running";
  const cacheNote =
    step.name === "cache"
      ? cacheHit === undefined
        ? null
        : cacheHit
          ? "Cache hit · skipping generation"
          : "Cache miss · running full generation"
      : null;

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="mt-0.5">
        <StepIcon status={step.status} />
      </div>
      <div className="flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">
            {STEP_LABELS[step.name]}
          </span>
          <StepBadge status={step.status} stepName={step.name} cacheHit={cacheHit} />
        </div>
        <p className="text-xs text-muted-foreground">
          {STEP_HINTS[step.name]}
        </p>
        {cacheNote ? (
          <p className="mt-1 font-mono text-[11px] text-primary">
            {cacheNote}
          </p>
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
      {step.finishedAt ? (
        <span className="font-mono text-[11px] text-muted-foreground">
          {new Date(step.finishedAt).toLocaleTimeString()}
        </span>
      ) : null}
    </div>
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
