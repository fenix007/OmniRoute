import { resolveProxyForConnection } from "@/lib/db/settings";
import { MODEL_MAP, RESEARCH_MODE } from "@omniroute/open-sse/executors/perplexity-web/wire.ts";
import {
  fetchPerplexityRateLimits,
  type PerplexityAuth,
} from "@omniroute/open-sse/services/perplexityQuotaFetcher.ts";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";
import * as log from "../utils/logger";

/** Only catalog models have a known counter; raw model preferences remain unchanged. */
export function getPerplexityQuotaCounter(model: string | null): "research" | "pro" | null {
  const name = model?.replace(/^(?:perplexity-web|pplx-web)\//, "");
  if (!name || !Object.hasOwn(MODEL_MAP, name)) return null;
  return MODEL_MAP[name][0] === RESEARCH_MODE ? "research" : "pro";
}

/**
 * Fetch the requested model's counters before affinity/priority/round-robin.
 * No research requests, account-wide cooldowns, or percentage conversion here.
 * The fetcher's 60s cache is shared with the executor and invalidated after use.
 */
export async function filterPerplexityConnectionsByQuota<T extends PerplexityAuth & { id: string }>(
  connections: T[],
  model: string | null
): Promise<{ eligible: T[]; exhausted: T[] } | null> {
  const counter = getPerplexityQuotaCounter(model);
  if (!counter) return null;

  const observations = await Promise.all(
    connections.map(async (connection) => {
      try {
        const proxy = await resolveProxyForConnection(connection.id);
        const limits = await runWithProxyContext(proxy?.proxy || null, () =>
          fetchPerplexityRateLimits(connection.id, connection)
        );
        return { connection, remaining: limits?.[counter] ?? null };
      } catch {
        // Do not expose proxy URLs or session cookies in errors.
        log.warn("AUTH", `perplexity-web | quota unavailable for ${connection.id.slice(0, 8)}`);
        return { connection, remaining: null };
      }
    })
  );

  const ready = observations.filter((item) => item.remaining !== null && item.remaining > 0);
  const unknown = observations.filter((item) => item.remaining === null);
  const exhausted = observations.filter((item) => item.remaining === 0);
  // Prefer proven availability. Unknown is a fallback only when no known account
  // can serve; a quota endpoint outage must not disable the whole provider.
  return {
    eligible: (ready.length > 0 ? ready : unknown).map((item) => item.connection),
    exhausted: exhausted.map((item) => item.connection),
  };
}
