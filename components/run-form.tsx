"use client";

import {
  useActionState,
  useEffect,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
  submitRunAction,
  validateSchemaAction,
  type SubmitRunResult,
  type ValidateSchemaResult,
} from "@/lib/ui-actions";
import { HARD_CAPS } from "@/lib/ui-types";

type SchemaCheck =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok"; tables: number }
  | { status: "error"; message: string };

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
  const [check, setCheck] = useState<SchemaCheck>({ status: "idle" });
  const [, startCheck] = useTransition();

  const schemaBytes = new TextEncoder().encode(schema).byteLength;
  const overByteCap = schemaBytes > HARD_CAPS.maxSchemaBytes;
  const overRowCap =
    Number.parseInt(volume, 10) > HARD_CAPS.maxRows ||
    state.truncated !== undefined;

  useEffect(() => {
    const trimmed = schema.trim();
    if (trimmed.length === 0) {
      // Schema reset — sync the status pill with the cleared textarea.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCheck({ status: "idle" });
      return;
    }
    setCheck({ status: "checking" });
    let cancelled = false;
    const handle = setTimeout(() => {
      startCheck(async () => {
        const result: ValidateSchemaResult = await validateSchemaAction(trimmed);
        if (cancelled) return;
        setCheck(
          result.ok
            ? { status: "ok", tables: result.tables }
            : { status: "error", message: result.error },
        );
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [schema]);

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <Field
        htmlFor="schema"
        label="Postgres schema"
        meta={
          <div className="flex items-center gap-2">
            <SchemaCheckPill check={check} />
            <span className="font-mono text-xs text-muted-foreground">
              {schemaBytes.toLocaleString()} /{" "}
              {HARD_CAPS.maxSchemaBytes.toLocaleString()} bytes
              {overByteCap ? " — over cap" : ""}
            </span>
          </div>
        }
        info={
          <>
            <p className="font-medium text-foreground">Accepted subset</p>
            <p>
              Tables, columns, types, primary keys, foreign keys, NOT NULL,
              UNIQUE, CHECK, and ENUM-as-text + CHECK.
            </p>
            <p>
              Triggers, stored functions, partitioning, and custom domains
              are rejected with a named parse error before any data is
              generated.
            </p>
          </>
        }
        error={state.errors?.schema}
      >
        <Textarea
          id="schema"
          name="schema"
          rows={14}
          spellCheck={false}
          aria-invalid={Boolean(state.errors?.schema)}
          className="font-mono text-xs"
          placeholder="CREATE TABLE customers ( id uuid PRIMARY KEY, ... );"
          value={schema}
          onChange={(e) => setSchema(e.target.value)}
        />
      </Field>

      <Field
        htmlFor="context"
        label="Product context"
        info={
          <>
            <p className="font-medium text-foreground">Why this matters</p>
            <p>
              A short, plain-English description of the product the schema
              belongs to. The planner reads it to propose coverage
              scenarios — tier mixes, status distributions, edge cases —
              tailored to your domain rather than generic data.
            </p>
          </>
        }
        error={state.errors?.context}
      >
        <Textarea
          id="context"
          name="context"
          rows={4}
          aria-invalid={Boolean(state.errors?.context)}
          placeholder="Mid-size DTC apparel store. Catalog of ~120 active SKUs..."
          defaultValue={state.values?.context ?? defaultContext}
        />
      </Field>

      <Field
        htmlFor="volume"
        label="Target volume (rows)"
        meta={
          <span className="font-mono text-xs text-muted-foreground">
            max {HARD_CAPS.maxRows.toLocaleString()}
          </span>
        }
        info={
          <>
            <p className="font-medium text-foreground">How volume is used</p>
            <p>
              Total rows across all tables, distributed proportionally by
              coverage. Generation runs one table at a time in foreign-key
              order, so referential integrity is guaranteed by construction.
            </p>
            <p>
              200–500 rows is typical for previews; up to{" "}
              {HARD_CAPS.maxRows.toLocaleString()} works for dense schemas.
              Requests above the cap are truncated.
            </p>
          </>
        }
        error={state.errors?.volume}
      >
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
      </Field>

      {state.truncated ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
        >
          <AlertTriangle className="size-4 shrink-0 text-primary" aria-hidden />
          <span>
            Requested volume exceeded the{" "}
            {HARD_CAPS.maxRows.toLocaleString()}-row cap and was truncated
            to {state.truncated.volume.toLocaleString()}.
          </span>
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-3 pt-2">
        {overRowCap && !state.truncated ? (
          <p className="text-xs text-muted-foreground">
            Will be truncated to {HARD_CAPS.maxRows.toLocaleString()} rows.
          </p>
        ) : null}
        <Button
          type="submit"
          disabled={pending || overByteCap || check.status === "error"}
        >
          {pending ? "Planning…" : "Plan run"}
        </Button>
      </div>
    </form>
  );
}

function SchemaCheckPill({ check }: { check: SchemaCheck }) {
  if (check.status === "idle") return null;
  if (check.status === "checking") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        Checking
      </span>
    );
  }
  if (check.status === "ok") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="size-3" aria-hidden />
        Valid · {check.tables} tables
      </span>
    );
  }
  return (
    <Popover>
      <PopoverTrigger
        type="button"
        aria-label="Schema validation error"
        className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-destructive transition-colors hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <XCircle className="size-3" aria-hidden />
        Invalid
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-72 text-xs leading-relaxed"
      >
        <p className="font-medium text-foreground">Parser would reject</p>
        <p className="text-muted-foreground">{check.message}</p>
      </PopoverContent>
    </Popover>
  );
}

interface FieldProps {
  htmlFor: string;
  label: string;
  info: ReactNode;
  meta?: ReactNode;
  error?: string;
  children: ReactNode;
}

function Field({ htmlFor, label, info, meta, error, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <Label htmlFor={htmlFor}>{label}</Label>
          <Popover>
            <PopoverTrigger
              type="button"
              aria-label={`About ${label}`}
              className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              <Info className="size-3.5" aria-hidden />
            </PopoverTrigger>
            <PopoverContent
              align="start"
              side="top"
              className="w-80 text-xs leading-relaxed text-muted-foreground"
            >
              {info}
            </PopoverContent>
          </Popover>
        </div>
        {meta}
      </div>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
