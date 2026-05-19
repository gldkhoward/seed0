import { TopNav } from "@/components/top-nav";
import { RunForm } from "@/components/run-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getTemplate } from "@/lib/fixtures";

interface NewRunPageProps {
  searchParams: Promise<{ example?: string }>;
}

export default async function NewRunPage({ searchParams }: NewRunPageProps) {
  const params = await searchParams;
  const template = params.example ? getTemplate(params.example) : undefined;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <TopNav current="new" />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-12 md:py-16">
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            New run
          </span>
          <h1 className="text-3xl font-semibold tracking-tight">
            Configure a seed run.
          </h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              Run details
            </CardTitle>
            <CardDescription>
              {template
                ? `Prefilled from the ${template.tables}-table ${template.name} template.`
                : "Schemas above the size limit are rejected at submission with a clear message."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RunForm
              defaultSchema={template?.ddl ?? ""}
              defaultContext={template?.context ?? ""}
              defaultVolume={500}
            />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
