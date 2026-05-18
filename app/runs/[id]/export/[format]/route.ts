import { canonicalJson, canonicalSql } from "@/lib/canonical-export";
import { getRun } from "@/lib/run-store";

interface RouteContext {
  params: Promise<{ id: string; format: string }>;
}

export async function GET(_req: Request, ctx: RouteContext) {
  const { id, format } = await ctx.params;
  const run = await getRun(id);
  if (!run) {
    return new Response("Not found", { status: 404 });
  }
  if (!run.canonicalDataset) {
    return new Response("Canonical dataset is not yet materialized.", {
      status: 409,
    });
  }
  if (format === "json") {
    return new Response(canonicalJson(run.canonicalDataset), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${run.id}.json"`,
      },
    });
  }
  if (format === "sql") {
    return new Response(canonicalSql(run.canonicalDataset), {
      headers: {
        "content-type": "application/sql; charset=utf-8",
        "content-disposition": `attachment; filename="${run.id}.sql"`,
      },
    });
  }
  return new Response("Unsupported format. Use 'json' or 'sql'.", {
    status: 400,
  });
}
