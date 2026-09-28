/**
 * Expired-connection recovery for the token health check: retry/backoff state
 * and the upstream access-token probe that restores falsely expired accounts.
 */

import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";
import { probeOAuthAccessToken } from "@/lib/providers/oauthTestConfig";
import { getEffectiveTokenExpiryMs } from "./tokenHealthCheckHelpers";

const EXPIRED_RETRY_BACKOFF_MIN = 5; // backoff between expired retries (minutes)
const EXPIRED_RETRY_BACKOFF_MAX_MIN = 240; // cap for expired retry backoff (minutes)
const TOKEN_EXPIRY_BUFFER = 5 * 60 * 1000; // 5 minutes

export type ExpiredProbeResult =
  | { outcome: "recovered" | "unsupported" }
  | { outcome: "failed"; error: string; nextProbeMin: number };

/**
 * Strip the refresh circuit breaker and expired-retry state from
 * providerSpecificData after a successful refresh or probe, so the
 * streak/backoff resets cleanly.
 */
export function clearRefreshCircuit(
  providerSpecificData: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  if (!providerSpecificData || typeof providerSpecificData !== "object") return undefined;
  if (!("refreshCircuit" in providerSpecificData) && !("expiredRetry" in providerSpecificData)) {
    return undefined;
  }
  const next = { ...providerSpecificData };
  delete next.refreshCircuit;
  delete next.expiredRetry;
  return next;
}

// Expired-retry state lives in providerSpecificData: provider_connections has no
// expired_retry_* columns, so top-level fields were silently dropped on write and
// every sweep saw attempt 1 again, retrying forever without backoff.
export function getExpiredRetryState(conn: any): { count: number; at: string | null } {
  const state = conn?.providerSpecificData?.expiredRetry;
  const count = Number(state?.count);
  return {
    count: Number.isFinite(count) && count > 0 ? count : 0,
    at: typeof state?.at === "string" ? state.at : null,
  };
}

export function getExpiredRetryBackoffMs(count: number): number {
  const backoffMin = Math.min(
    EXPIRED_RETRY_BACKOFF_MIN * 2 ** Math.max(0, count),
    EXPIRED_RETRY_BACKOFF_MAX_MIN
  );
  return backoffMin * 60 * 1000;
}

export function withExpiredRetryAttempt(
  providerSpecificData: Record<string, unknown> | null | undefined,
  now: string
): Record<string, unknown> {
  const { count } = getExpiredRetryState({ providerSpecificData });
  return { ...(providerSpecificData || {}), expiredRetry: { count: count + 1, at: now } };
}

/**
 * Upstream 401s can mark a still-valid OAuth account `expired`: during the Codex
 * incident on 2026-09-25 every account got "Incorrect API key provided" at once.
 * Probe the stored access token with the connection-test request instead of
 * refreshing, so a rotating single-use refresh token is never consumed.
 */
export async function probeExpiredConnection(
  conn: any,
  proxyConfig: unknown
): Promise<ExpiredProbeResult> {
  // A lapsed access token cannot be probed; leave it to the refresh path.
  if (getEffectiveTokenExpiryMs(conn) <= Date.now() + TOKEN_EXPIRY_BUFFER) {
    return { outcome: "unsupported" };
  }

  let result: { valid: boolean; status: number } | null;
  let error: string;
  try {
    result = await runWithProxyContext(proxyConfig, () => probeOAuthAccessToken(conn));
    if (!result) return { outcome: "unsupported" };
    error = `upstream returned ${result.status}`;
  } catch (err: unknown) {
    result = { valid: false, status: 0 };
    error = err instanceof Error ? err.message : String(err);
  }

  const now = new Date().toISOString();
  const latest = (await getProviderConnectionById(conn.id)) || conn;

  if (result.valid) {
    const clearedProviderData = clearRefreshCircuit(latest.providerSpecificData);
    await updateProviderConnection(conn.id, {
      testStatus: "active",
      lastHealthCheckAt: now,
      lastError: null,
      lastErrorAt: null,
      lastErrorType: null,
      lastErrorSource: null,
      errorCode: null,
      rateLimitedUntil: null,
      backoffLevel: 0,
      ...(clearedProviderData !== undefined ? { providerSpecificData: clearedProviderData } : {}),
    });
    return { outcome: "recovered" };
  }

  const providerSpecificData = withExpiredRetryAttempt(latest.providerSpecificData, now);
  await updateProviderConnection(conn.id, {
    lastHealthCheckAt: now,
    lastError: `Health check probe failed: ${error}`,
    lastErrorAt: now,
    providerSpecificData,
  });
  const { count } = getExpiredRetryState({ providerSpecificData });
  return { outcome: "failed", error, nextProbeMin: getExpiredRetryBackoffMs(count) / 60000 };
}
