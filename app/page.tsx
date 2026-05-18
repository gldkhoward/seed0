import Link from "next/link";
import { ArrowRight, Database, ShieldCheck, Workflow } from "lucide-react";

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
import { Separator } from "@/components/ui/separator";

export const dynamic = "force-static";

const featureTiles = [
  {
    icon: Database,
    title: "Parse the real DDL",
    body: "Postgres CREATE TABLE in, entity model out. AST-driven, not regex. Unsupported constructs are rejected with a named error, not silently ignored.",
  },
  {
    icon: Workflow,
    title: "Model proposes, tools verify",
    body: "The model emits scenarios and structured predicates. Deterministic code parses, validates, evaluates predicates, and scores. The LLM is never the trust boundary.",
  },
  {
    icon: ShieldCheck,
    title: "Confirmed plans, not promises",
    body: "You confirm the scenario plan and see a deterministic pre-run cost estimate before generation runs. Hard caps refuse or truncate at submission.",
  },
];

const exampleTemplates = [
  {
    slug: "ecommerce",
    name: "8-table ecommerce",
    summary:
      "customers · products · inventory · orders · order_items · shipments · refunds · reviews",
    scenarios: 8,
  },
];

export default function HomePage() {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <TopNav current="home" />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 px-6 py-12">
        <Card className="overflow-hidden">
          <CardHeader className="gap-4">
            <Badge variant="outline" className="w-fit text-xs">
              Track B · model proposes, tools verify
            </Badge>
            <CardTitle className="text-3xl font-semibold leading-tight tracking-tight md:text-4xl">
              Seed data your preview deployments can be reviewed against.
            </CardTitle>
            <CardDescription className="max-w-2xl text-base leading-relaxed">
              seed0 turns a Postgres schema and a product brief into a
              scenario-driven seed corpus, then proves it covers what you
              asked for through deterministic predicates and a constraint
              pass rate. No vibes; every point in the readiness score
              traces to a named scenario.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <Link href="/new">
              <Button size="lg">
                Start a run
                <ArrowRight className="ml-1" aria-hidden="true" />
              </Button>
            </Link>
            <Link href="/runs">
              <Button size="lg" variant="outline">
                See run history
              </Button>
            </Link>
          </CardContent>
        </Card>

        <section className="grid gap-4 md:grid-cols-3">
          {featureTiles.map(({ icon: Icon, title, body }) => (
            <Card key={title}>
              <CardHeader className="gap-3">
                <Icon
                  className="size-5 text-primary"
                  aria-hidden="true"
                />
                <CardTitle className="text-base font-semibold">
                  {title}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {body}
                </p>
              </CardContent>
            </Card>
          ))}
        </section>

        <section className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold tracking-tight">
              Example templates
            </h2>
            <span className="font-mono text-xs text-muted-foreground">
              static / cached
            </span>
          </div>
          <Separator />
          <div className="grid gap-4 md:grid-cols-2">
            {exampleTemplates.map((tpl) => (
              <Card key={tpl.slug}>
                <CardHeader className="gap-2">
                  <CardTitle className="text-base font-semibold">
                    {tpl.name}
                  </CardTitle>
                  <CardDescription className="font-mono text-xs">
                    {tpl.summary}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between">
                  <Badge variant="secondary" className="font-mono">
                    {tpl.scenarios} predicate-bearing scenarios
                  </Badge>
                  <Link href={`/new?example=${tpl.slug}`}>
                    <Button size="sm" variant="outline">
                      Use template
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-6 text-xs text-muted-foreground">
          <span>seed0 · production-realistic seed data, proven trustworthy</span>
          <span className="font-mono">Vercel Workflows · Blob · AI SDK</span>
        </div>
      </footer>
    </div>
  );
}
