import { generateObject } from "ai";
import type { z } from "zod";

export async function structuredOutput<T extends z.ZodType>(opts: {
  model: string;
  schema: T;
  prompt: string;
  system?: string;
}) {
  return generateObject({
    model: opts.model,
    schema: opts.schema,
    prompt: opts.prompt,
    system: opts.system,
  });
}
