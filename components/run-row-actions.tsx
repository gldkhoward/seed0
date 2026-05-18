"use client";

import { useState, useTransition } from "react";
import { MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { rerunWithVolumeAction } from "@/lib/ui-actions";
import { HARD_CAPS } from "@/lib/ui-types";

interface RunRowActionsProps {
  runId: string;
  defaultVolume: number;
}

export function RunRowActions({ runId, defaultVolume }: RunRowActionsProps) {
  const [open, setOpen] = useState(false);
  const [volume, setVolume] = useState(String(defaultVolume));
  const [pending, startTransition] = useTransition();

  const presets = [500, 1000, 2000];

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label="Run actions" />
          }
        >
          <MoreHorizontal aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6}>
          {presets.map((p) => (
            <DropdownMenuItem
              key={p}
              onClick={() =>
                startTransition(() => rerunWithVolumeAction(runId, p))
              }
            >
              Re-run at {p.toLocaleString()} rows
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setOpen(true)}>
            Re-run with custom volume…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-run with new volume</DialogTitle>
            <DialogDescription>
              Reuses the prior run&apos;s canonical schema and confirmed plan.
              Scale-down samples the cached corpus; scale-up generates only the
              delta — neither re-invokes the model.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rerun-volume">Target volume</Label>
            <Input
              id="rerun-volume"
              type="number"
              min={1}
              max={HARD_CAPS.maxRows}
              step={50}
              value={volume}
              onChange={(e) => setVolume(e.target.value)}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Capped at {HARD_CAPS.maxRows.toLocaleString()} rows. Volume is
              not part of the cache key, so any value within the cap
              exercises the cache path.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() => {
                const v = Math.min(
                  HARD_CAPS.maxRows,
                  Math.max(1, Number.parseInt(volume, 10) || defaultVolume),
                );
                startTransition(() => rerunWithVolumeAction(runId, v));
              }}
            >
              {pending ? "Starting…" : "Re-run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
