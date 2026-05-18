import { TopNav } from "@/components/top-nav";
import { RunForm } from "@/components/run-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ECOMMERCE_CONTEXT as EXAMPLE_CONTEXT,
  ECOMMERCE_DDL as EXAMPLE_SCHEMA,
} from "@/lib/fixtures/ecommerce";

interface NewRunPageProps {
  searchParams: Promise<{ example?: string }>;
}

export default async function NewRunPage({ searchParams }: NewRunPageProps) {
  const params = await searchParams;
  const usingExample = params.example === "ecommerce";

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <TopNav current="new" />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-10">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">New run</h1>
          <p className="text-sm text-muted-foreground">
            Provide a Postgres schema, a plain-English product description,
            and a target volume. The planner produces a scenario plan for
            you to confirm before generation runs.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              Configure run
            </CardTitle>
            <CardDescription>
              {usingExample
                ? "Prefilled from the 8-table ecommerce example template."
                : "Hard caps are enforced at submission with a clear message."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RunForm
              defaultSchema={usingExample ? EXAMPLE_SCHEMA : ""}
              defaultContext={usingExample ? EXAMPLE_CONTEXT : ""}
              defaultVolume={500}
            />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
