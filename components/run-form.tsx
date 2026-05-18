"use client";

import { useActionState, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { submitRunAction, type SubmitRunResult } from "@/lib/ui-actions";
import { HARD_CAPS } from "@/lib/ui-types";

const initialState: SubmitRunResult = { ok: true };

interface RunFormProps {
  defaultSchema?: string;
  defaultContext?: string;
  defaultVolume?: number;
}

export function RunForm({
  defaultSchema = "",
  defaultContext = "",
  defaultVolume = 500,
}: RunFormProps) {
  const [state, formAction, pending] = useActionState(
    submitRunAction,
    initialState,
  );
  const [schema, setSchema] = useState(state.values?.schema ?? defaultSchema);
  const [volume, setVolume] = useState(
    state.values?.volume ?? String(defaultVolume),
  );

  const schemaBytes = new TextEncoder().encode(schema).byteLength;
  const schemaPct = Math.min(
    100,
    Math.round((schemaBytes / HARD_CAPS.maxSchemaBytes) * 100),
  );
  const overByteCap = schemaBytes > HARD_CAPS.maxSchemaBytes;
  const overRowCap =
    Number.parseInt(volume, 10) > HARD_CAPS.maxRows ||
    state.truncated !== undefined;

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <Label htmlFor="schema">Postgres schema</Label>
          <span className="font-mono text-xs text-muted-foreground">
            {schemaBytes.toLocaleString()} / {HARD_CAPS.maxSchemaBytes.toLocaleString()} bytes
            {overByteCap ? " — over cap" : ""} · {schemaPct}%
          </span>
        </div>
        <Textarea
          id="schema"
          name="schema"
          rows={14}
          spellCheck={false}
          aria-invalid={Boolean(state.errors?.schema)}
          aria-describedby="schema-help"
          className="font-mono text-xs"
          placeholder="CREATE TABLE customers ( id uuid PRIMARY KEY, ... );"
          value={schema}
          onChange={(e) => setSchema(e.target.value)}
        />
        <p id="schema-help" className="text-xs text-muted-foreground">
          Accepted subset: tables, columns, types, PRIMARY KEY, FOREIGN KEY,
          NOT NULL, UNIQUE, CHECK, ENUM. Triggers, functions, partitioning,
          and custom domains are rejected with a named error.
        </p>
        {state.errors?.schema ? (
          <p role="alert" className="text-xs text-destructive">
            {state.errors.schema}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="context">Product context</Label>
        <Textarea
          id="context"
          name="context"
          rows={4}
          aria-invalid={Boolean(state.errors?.context)}
          placeholder="Mid-size DTC apparel store. Catalog of ~120 active SKUs..."
          defaultValue={state.values?.context ?? defaultContext}
        />
        <p className="text-xs text-muted-foreground">
          Plain-English description of the product. Used by the planner to
          propose predicate-bearing scenarios.
        </p>
        {state.errors?.context ? (
          <p role="alert" className="text-xs text-destructive">
            {state.errors.context}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <Label htmlFor="volume">Target volume (rows)</Label>
          <span className="font-mono text-xs text-muted-foreground">
            max {HARD_CAPS.maxRows.toLocaleString()}
          </span>
        </div>
        <Input
          id="volume"
          name="volume"
          type="number"
          inputMode="numeric"
          min={1}
          max={HARD_CAPS.maxRows}
          step={1}
          aria-invalid={Boolean(state.errors?.volume)}
          className="font-mono"
          value={volume}
          onChange={(e) => setVolume(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Total rows across all tables. The default run is ~500 rows; 2000
          exercises the cache delta path.
        </p>
        {state.errors?.volume ? (
          <p role="alert" className="text-xs text-destructive">
            {state.errors.volume}
          </p>
        ) : null}
      </div>

      {state.truncated ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
        >
          <AlertTriangle className="size-4 shrink-0 text-primary" aria-hidden />
          <span>
            Requested volume exceeded the {HARD_CAPS.maxRows.toLocaleString()}-row cap and was truncated to {state.truncated.volume.toLocaleString()}.
          </span>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 pt-2">
        <p className="text-xs text-muted-foreground">
          Submission parses the schema and runs the planner. You will confirm
          the plan and pre-run cost estimate before generation runs.
        </p>
        <Button type="submit" disabled={pending || overByteCap}>
          {pending ? "Planning…" : "Plan run"}
        </Button>
      </div>
      {overRowCap && !state.truncated ? (
        <p className="text-xs text-muted-foreground">
          Submitting will truncate the request to {HARD_CAPS.maxRows.toLocaleString()} rows.
        </p>
      ) : null}
    </form>
  );
}
