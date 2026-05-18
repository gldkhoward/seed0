import { generateObject } from "ai";
import type { z } from "zod";

/**
 * Default output-token ceiling for structured generation. The AI SDK
 * defaults to whatever the model defaults to (often 4-8K), which is
 * far too low for the generator step — we routinely produce 10-30K
 * tokens of JSON for a 200-row seed corpus. 16K is a safe headroom
 * that fits every model we target via AI Gateway. The generator can
 * override per-call when chunking lands (§6.4).
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

export async function structuredOutput<T extends z.ZodType>(opts: {
  model: string;
  schema: T;
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
}) {
  return generateObject({
    model: opts.model,
    schema: opts.schema,
    prompt: opts.prompt,
    system: opts.system,
    maxOutputTokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  });
}
