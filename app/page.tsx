import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Database,
  ListChecks,
  Sprout,
} from "lucide-react";

import { TopNav } from "@/components/top-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { TEMPLATES } from "@/lib/fixtures";

export const dynamic = "force-static";

const steps = [
  {
    icon: Database,
    label: "Step 01",
    title: "Bring your schema",
    body: "Paste a Postgres CREATE TABLE script or start from a template. Tables, columns, constraints, and enums are read as-is — no decoration, no surprises.",
  },
  {
    icon: ListChecks,
    label: "Step 02",
    title: "Review the plan",
    body: "seed0 proposes a coverage plan and a pre-run cost estimate. You see the scenarios and total before any data is generated, and you confirm explicitly.",
  },
  {
    icon: CheckCircle2,
    label: "Step 03",
    title: "Ship validated seed data",
    body: "Download a canonical JSON dataset or dependency-ordered Postgres SQL. Every record is constraint-checked, so previews never come up empty.",
  },
];

interface Template {
  slug: string;
  name: string;
  tables: number;
  summary: string;
  available: boolean;
}

// Every template is exercised by the eval regression (see
// lib/eval/workflow-pipeline.ts + scripts/run-eval.ts) and currently
// passes 100% constraints / 100% predicate coverage on the shipping
// chunkedGenerate + repair-agent path. The eval is the gate — if a
// template ever regresses, flip its `available` to false until it
// passes again. Run `pnpm eval -- --all` to verify the matrix.
const templates: Template[] = TEMPLATES.map((t) => ({
  slug: t.slug,
  name: t.name,
  tables: t.tables,
  summary: t.summary,
  available: true,
}));

export default function HomePage() {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <TopNav current="home" />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-20 px-6 py-16 md:py-20">
        <Hero />
        <HowItWorks />
        <Templates />
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-6 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Sprout className="size-3.5 text-primary" aria-hidden />
            seed0 · Postgres seed data for preview deployments
          </span>
          <span className="font-mono">Built on Vercel</span>
        </div>
      </footer>
    </div>
  );
}

function Hero() {
  return (
    <section className="flex flex-col gap-6">
      <Badge
        variant="outline"
        className="w-fit gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em]"
      >
        <span className="size-1.5 rounded-full bg-primary" aria-hidden />
        Postgres · Vercel-native
      </Badge>
      <h1 className="max-w-3xl text-4xl font-semibold leading-[1.05] tracking-tight md:text-5xl">
        Realistic seed data, on demand.
      </h1>
      <p className="max-w-2xl text-base leading-relaxed text-muted-foreground md:text-lg">
        seed0 turns a Postgres schema into a coverage-driven seed dataset
        for your preview deployments — every record validated against your
        constraints before it ever lands in a database.
      </p>
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Link href="/new">
          <Button size="lg">
            Start a run
            <ArrowRight className="ml-1" aria-hidden />
          </Button>
        </Link>
        <Link href="/runs">
          <Button size="lg" variant="outline">
            View run history
          </Button>
        </Link>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="flex flex-col gap-6">
      <SectionHeader
        eyebrow="How it works"
        title="Schema in, validated data out."
        aside="3 steps · about a minute"
      />
      <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-3">
        {steps.map(({ icon: Icon, label, title, body }) => (
          <div key={label} className="flex flex-col gap-3 bg-card p-6">
            <div className="flex items-center gap-2">
              <span className="inline-flex size-7 items-center justify-center rounded-md border border-border bg-background">
                <Icon className="size-3.5 text-primary" aria-hidden />
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                {label}
              </span>
            </div>
            <h3 className="text-base font-semibold tracking-tight">{title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Templates() {
  return (
    <section className="flex flex-col gap-6">
      <SectionHeader
        eyebrow="Templates"
        title="Start from a known-good schema."
        aside={
          <Link
            href="/new"
            className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
          >
            Bring your own →
          </Link>
        }
      />
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        {templates.map((tpl) => (
          <TemplateCard key={tpl.slug} tpl={tpl} />
        ))}
      </div>
    </section>
  );
}

function TemplateCard({ tpl }: { tpl: Template }) {
  const body = (
    <div
      className={
        "flex h-full flex-col gap-3 rounded-lg border border-border bg-card p-5 transition-colors " +
        (tpl.available
          ? "hover:border-foreground/20 hover:bg-muted/40"
          : "opacity-70")
      }
    >
      <div className="flex items-center justify-between">
        <Badge variant="outline" className="font-mono text-[10px]">
          {tpl.tables} tables
        </Badge>
        {tpl.available ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-primary">
            Available
          </span>
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Soon
          </span>
        )}
      </div>
      <h3 className="text-base font-semibold tracking-tight">{tpl.name}</h3>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {tpl.summary}
      </p>
      {tpl.available ? (
        <span className="mt-auto inline-flex items-center gap-1 pt-1 text-xs font-medium text-foreground">
          Use template
          <ArrowRight className="size-3" aria-hidden />
        </span>
      ) : (
        <span className="mt-auto pt-1 text-xs text-muted-foreground">
          In development
        </span>
      )}
    </div>
  );

  if (!tpl.available) return body;
  return <Link href={`/new?example=${tpl.slug}`}>{body}</Link>;
}

interface SectionHeaderProps {
  eyebrow: string;
  title: string;
  aside?: React.ReactNode;
}

function SectionHeader({ eyebrow, title, aside }: SectionHeaderProps) {
  return (
    <>
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {eyebrow}
          </span>
          <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        </div>
        {typeof aside === "string" ? (
          <span className="font-mono text-xs text-muted-foreground">
            {aside}
          </span>
        ) : (
          aside
        )}
      </div>
      <Separator />
    </>
  );
}
