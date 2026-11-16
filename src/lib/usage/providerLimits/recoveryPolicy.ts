import {
  CLAUDE_EXTRA_USAGE_ERROR_SOURCE,
  isClaudeExtraUsageBlockEnabled,
  isClaudeExtraUsageQueued,
} from "@/lib/providers/claudeExtraUsage";
import { rotationGroupFor } from "@omniroute/open-sse/services/refreshSerializer.ts";
import { isRecord } from "./quotaNormalize";
import type { JsonRecord, ProviderConnectionLike } from "./types";

/**
 * Decide whether the quota-sync path should flag a connection `expired` from an
 * auth-style usage error. Exported for unit testing.
 *
 * Rotating-refresh providers (Codex/OpenAI/Claude/etc. — see refreshSerializer's
 * ROTATION_LOCK_GROUP) have their access_token deliberately NOT proactively
 * refreshed in this quota path (#3019, to avoid the Auth0 family-revocation
 * cascade). So a "token expired" from the quota fetch is a recoverable
 * false-negative: the credential is still valid (its `expires_at` is in the
 * future) and the reactive, serialized 401 path refreshes the access_token on
 * next use. Flagging it `expired` hides a healthy account from the quota page
 * (observed: freshly-added Codex accounts flagged expired while a providers-page
 * refresh turns them green). So never mark a rotating provider expired from the
 * quota sync — leave its status to the reactive path / connection test.
 */
export function quotaPathShouldMarkExpired(
  provider: string,
  usageMessage: unknown,
  currentTestStatus: string | null | undefined
): boolean {
  if (currentTestStatus === "expired") return false;

  const message = typeof usageMessage === "string" ? usageMessage.toLowerCase() : "";
  const isAuthError =
    message.includes("token expired") ||
    message.includes("access denied") ||
    message.includes("re-authenticate") ||
    message.includes("unauthorized");
  if (!isAuthError) return false;

  if (rotationGroupFor(provider) !== null) return false;

  return true;
}

const TERMINAL_STATUSES_FOR_QUOTA_RECOVERY = new Set([
  "credits_exhausted",
  "banned",
  "expired",
  "deactivated",
]);

export function isTerminalStatusForQuotaRecovery(testStatus: string | null | undefined): boolean {
  if (!testStatus) return false;
  return TERMINAL_STATUSES_FOR_QUOTA_RECOVERY.has(testStatus);
}

export function hasUsableQuota(usage: JsonRecord): boolean {
  const quotas = usage?.quotas;
  if (!isRecord(quotas)) return false;
  for (const value of Object.values(quotas)) {
    if (!isRecord(value)) continue;
    if (value.unlimited === true) return true;
    const remaining =
      typeof value.remaining === "number"
        ? value.remaining
        : typeof value.remainingPercentage === "number"
          ? value.remainingPercentage
          : null;
    if (remaining !== null && remaining > 0) return true;
  }
  return false;
}

// A window "still blocks" recovery when it governs quota and is either still
// exhausted with a real reset that hasn't passed yet, or exhausted with no
// parseable real reset at all (unknown-reset windows stay locked, matching
// the pre-existing kimi-coding partial-refresh semantics).
export function windowStillExhaustedAfterRealReset(value: unknown, nowMs: number): boolean {
  if (!isRecord(value)) return false;
  if (value.unlimited === true) return false;
  const remaining =
    typeof value.remaining === "number"
      ? value.remaining
      : typeof value.remainingPercentage === "number"
        ? value.remainingPercentage
        : null;
  if (remaining !== null && remaining > 0) return false;
  if (value.resetAt == null) return true;
  const resetMs = Date.parse(String(value.resetAt));
  if (Number.isNaN(resetMs)) return true;
  return resetMs > nowMs;
}

export function isUsageAuthError(message: unknown): boolean {
  if (typeof message !== "string") return false;
  const m = message.toLowerCase();
  return (
    m.includes("token expired") ||
    m.includes("unauthorized") ||
    m.includes("re-authenticate") ||
    m.includes("access denied") ||
    m.includes("invalidated") ||
    m.includes("401")
  );
}

export function isNetworkFailureMessage(message: unknown): boolean {
  if (typeof message !== "string") return false;
  return (
    message.includes("fetch failed") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ETIMEDOUT") ||
    message.includes("Proxy unreachable") ||
    message.includes("UND_ERR_CONNECT_TIMEOUT")
  );
}

export function quotaRecoveryStillBlocked(
  connection: ProviderConnectionLike,
  usage: JsonRecord
): boolean {
  if (connection.lastErrorType === "quota_exhausted") {
    if (
      connection.lastErrorSource === CLAUDE_EXTRA_USAGE_ERROR_SOURCE &&
      isClaudeExtraUsageBlockEnabled(connection.provider, connection.providerSpecificData) &&
      isClaudeExtraUsageQueued(usage)
    ) {
      // Claude's pay-as-you-go extra-usage block is orthogonal to the
      // session/weekly quota windows checked below: the upstream can report a
      // fully recovered quota window while extraUsage.queued is still true.
      // Only syncClaudeExtraUsageStateIfNeeded (buildClaudeExtraUsageConnectionUpdate)
      // owns clearing this specific state — the general window-recovery logic
      // below must not release it just because some quota window looks fresh.
      return true;
    }

    const quotas = usage?.quotas;
    if (isRecord(quotas)) {
      // Honor the REAL per-window resetAt from the freshly fetched quota
      // instead of the synthetic cooldown persisted at failure time (e.g.
      // Claude's flat 1h SUBSCRIPTION_QUOTA_COOLDOWN_MS when no upstream
      // reset was parseable). Only stay locked if some window that governs
      // this connection's quota is still demonstrably exhausted.
      const anyStillBlocking = Object.values(quotas).some((value) =>
        windowStillExhaustedAfterRealReset(value, Date.now())
      );
      if (anyStillBlocking) return true;
    } else if (
      connection.rateLimitedUntil &&
      new Date(connection.rateLimitedUntil).getTime() > Date.now()
    ) {
      // No quota object at all (degraded/failed fetch shape) — fall back to
      // the previous synthetic-cooldown guard.
      return true;
    }
  }

  return false;
}

export function hasTransientQuotaState(connection: ProviderConnectionLike): boolean {
  return (
    connection.testStatus === "unavailable" ||
    Boolean(connection.rateLimitedUntil) ||
    Boolean(connection.lastError) ||
    Boolean(connection.errorCode) ||
    Boolean(connection.lastErrorType) ||
    Boolean(connection.lastErrorSource) ||
    (connection.backoffLevel ?? 0) > 0
  );
}
