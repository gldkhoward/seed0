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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
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
  plan: ScenarioPlan;
}

export function PlanConfirm({ runId, requestedVolume, plan }: PlanConfirmProps) {
  const [confirming, startConfirm] = useTransition();
  const [cancelling, startCancel] = useTransition();
  const cost = estimateRunCost(requestedVolume);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">
            Scenario plan
          </CardTitle>
          <CardDescription>
            Each scenario carries a structured predicate that the
            deterministic evaluator will match against canonical rows. The
            plan is not free-text editable; confirm to run, cancel to
            discard.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {plan.scenarios.map((s, i) => (
            <Card key={s.id} className="border-border/70 bg-card/60 shadow-none">
              <CardHeader className="gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="font-mono">
                    {String(i + 1).padStart(2, "0")} · {s.id}
                  </Badge>
                  <CardTitle className="text-sm font-medium">
                    {s.name}
                  </CardTitle>
                </div>
                <CardDescription className="text-xs">
                  {s.description}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Predicate
                  </span>
                  <Badge variant="outline" className="font-mono">
                    {s.predicate.table}
                  </Badge>
                  <Badge variant="secondary" className="font-mono text-[11px]">
                    {formatPredicateExpr(s.predicate.where)}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">
            Pre-run cost estimate
          </CardTitle>
          <CardDescription>
            Deterministic arithmetic over posted prices — not a predictive
            model. Hard caps still apply.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 font-mono text-xs sm:grid-cols-2">
          <CostRow
            label="Requested rows"
            value={cost.rows.toLocaleString()}
          />
          <CostRow
            label="Est. tokens / row"
            value={cost.tokensPerRow.toLocaleString()}
          />
          <CostRow
            label="Total generation tokens"
            value={cost.generationTokens.toLocaleString()}
          />
          <CostRow
            label="Model price"
            value={`$${cost.modelPricePerMTokens.toFixed(2)} / 1M tokens`}
          />
          <CostRow
            label="Generation cost"
            value={formatUsd(cost.generationUsd)}
          />
          <CostRow
            label="Planning cost (fixed)"
            value={formatUsd(cost.planningUsd)}
          />
          <Separator className="sm:col-span-2" />
          <div className="flex items-center justify-between sm:col-span-2">
            <span className="text-sm font-medium text-foreground">
              Estimated total
            </span>
            <span className="text-sm font-semibold text-foreground">
              {formatUsd(cost.totalUsd)}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground sm:col-span-2">
            {plan.scenarios.length} scenario
            {plan.scenarios.length === 1 ? "" : "s"} · run id {runId}
          </p>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <AlertDialog>
          <AlertDialogTrigger
            render={<Button variant="ghost" />}
            disabled={confirming || cancelling}
          >
            Cancel
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
                onClick={() => startCancel(() => cancelRunAction(runId))}
              >
                {cancelling ? "Cancelling…" : "Cancel run"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Button
          size="lg"
          disabled={confirming || cancelling}
          onClick={() => startConfirm(() => confirmRunAction(runId))}
        >
          {confirming ? "Starting generation…" : "Confirm and generate"}
        </Button>
      </div>
    </div>
  );
}

function CostRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/40 pb-2 last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}
