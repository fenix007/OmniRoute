import { z } from "zod";

const effort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const bodySchema = z.object({
  reasoning: z
    .object({ effort: effort.optional().catch(undefined) })
    .optional()
    .catch(undefined),
  reasoning_effort: effort.optional().catch(undefined),
});
const summarySchema = z.object({
  requestedEffort: effort.optional().catch(undefined),
  sentEffort: effort.optional().catch(undefined),
});

export function bodyEffort(value: unknown) {
  const parsed = bodySchema.safeParse(value);
  return parsed.success
    ? (parsed.data.reasoning?.effort ?? parsed.data.reasoning_effort)
    : undefined;
}

// Enum-only metadata. Never retain bodies, credentials or model-suffix guesses.
export function effortSummary(value: unknown) {
  const parsed = summarySchema.safeParse(value);
  if (!parsed.success) return {};
  return {
    ...(parsed.data.requestedEffort ? { requestedEffort: parsed.data.requestedEffort } : {}),
    ...(parsed.data.sentEffort ? { sentEffort: parsed.data.sentEffort } : {}),
  };
}
