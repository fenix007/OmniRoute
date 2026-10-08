import { z } from "zod";
import { toStringOrNull } from "./usageHistory/helpers";

export const SessionSourceSchema = z.enum([
  "header",
  "metadata",
  "conversation",
  "session",
  "prompt-cache",
  "input",
  "none",
]);

export const RoutingReasonSchema = z.enum([
  "affinity_reused",
  "affinity_created",
  "affinity_reassigned",
  "affinity_expired",
  "forced_connection",
  "strategy",
  "no_session",
  "deduplicated",
]);

export const SessionRoutingSchema = z
  .object({
    sessionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .nullable(),
    sessionSource: SessionSourceSchema,
    routingReason: RoutingReasonSchema,
    previousConnectionId: z.string().nullable().optional(),
  })
  .strict();

export type SessionSource = z.infer<typeof SessionSourceSchema>;
export type RoutingReason = z.infer<typeof RoutingReasonSchema>;
export type SessionRouting = Readonly<z.infer<typeof SessionRoutingSchema>>;
export type StoredSessionRouting = {
  session_hash: string | null;
  session_source: string | null;
  routing_reason: string | null;
  previous_connection_id: string | null;
};
export type UsageRoutingBackfillRow = StoredSessionRouting & {
  id: number;
  endpoint: string | null;
};

/**
 * Validate untrusted routing diagnostics without affecting request accounting.
 * Invalid or extended objects are discarded so raw session, prompt, or API-key
 * material can never leak into usage history through this metadata channel.
 */
export function parseSessionRouting(value: unknown): SessionRouting | null {
  const parsed = SessionRoutingSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : null;
}

export function markSessionRoutingDeduplicated(
  routing: SessionRouting | null,
  previousConnectionId: string | null
): SessionRouting | null {
  if (!routing) return null;
  return Object.freeze({
    ...routing,
    routingReason: "deduplicated" as const,
    previousConnectionId,
  });
}

export function mapStoredSessionRouting(row: Record<string, unknown>) {
  return {
    sessionHash: toStringOrNull(row.session_hash),
    sessionSource: toStringOrNull(row.session_source),
    routingReason: toStringOrNull(row.routing_reason),
    previousConnectionId: toStringOrNull(row.previous_connection_id),
  };
}

export function needsSessionRoutingBackfill(
  row: UsageRoutingBackfillRow,
  endpoint: string | null | undefined,
  routing: SessionRouting | null
): boolean {
  return Boolean(
    (!row.endpoint && endpoint) ||
    (!row.session_hash && routing?.sessionHash) ||
    (!row.session_source && routing?.sessionSource) ||
    (!row.routing_reason && routing?.routingReason) ||
    (!row.previous_connection_id && routing?.previousConnectionId)
  );
}
