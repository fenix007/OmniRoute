import { getQuotaCache } from "@/domain/quotaCache";
import { getCachedCodexResetCredits } from "@/lib/usage/codexResetCredits";
import { getCachedCodexQuota } from "@omniroute/open-sse/services/codexQuotaFetcher.ts";

type JsonRecord = Record<string, unknown>;

export interface CodexDeadlineConnection {
  id: string;
  priority: number;
  lastUsedAt: string | null;
  providerSpecificData: JsonRecord;
}

export interface CodexDeadlineScore {
  connectionId: string;
  weight: number;
  deadlineAt: string | null;
  sessionBlocked: boolean;
  requiredWeeklyBurn: number;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function futureTimestamp(value: unknown, nowMs: number): number | null {
  const parsed = timestamp(value);
  return parsed !== null && parsed > nowMs ? parsed : null;
}

function cachedWindows(connectionId: string) {
  const domain = getQuotaCache(connectionId);
  const dedicated = getCachedCodexQuota(connectionId);
  const session = domain?.quotas?.session ?? dedicated?.window5h ?? null;
  const weekly = domain?.quotas?.weekly ?? dedicated?.window7d ?? null;
  return {
    sessionRemaining: session
      ? "remainingPercentage" in session
        ? session.remainingPercentage
        : 100 - session.percentUsed
      : null,
    sessionResetAt: session?.resetAt ?? null,
    weeklyRemaining: weekly
      ? "remainingPercentage" in weekly
        ? weekly.remainingPercentage
        : 100 - weekly.percentUsed
      : null,
    weeklyResetAt: weekly?.resetAt ?? null,
    bankedResetCredits: dedicated?.bankedResetCredits ?? null,
  };
}

export function scoreCodexDeadlineConnection(
  connection: CodexDeadlineConnection,
  nowMs = Date.now()
): CodexDeadlineScore {
  const windows = cachedWindows(connection.id);
  const cachedCredits = getCachedCodexResetCredits(connection.id);
  const resetCredits = Math.max(
    0,
    Math.trunc(cachedCredits?.availableCount ?? windows.bankedResetCredits ?? 0)
  );
  const weeklyRemaining = Math.max(0, Math.min(100, windows.weeklyRemaining ?? 0));
  const requiredWeeklyBurn = Math.max(weeklyRemaining - 5, 0) + 95 * Math.max(resetCredits - 1, 0);
  const burnDeadlines = [
    futureTimestamp(connection.providerSpecificData.subscriptionActiveUntil, nowMs),
    ...(cachedCredits?.credits.map((credit) => futureTimestamp(credit.expiresAt, nowMs)) ?? []),
  ].filter((value): value is number => value !== null);
  const weeklyResetMs = futureTimestamp(windows.weeklyResetAt, nowMs);
  const deadlineMs = burnDeadlines.length > 0 ? Math.min(...burnDeadlines) : weeklyResetMs;
  const daysUntilDeadline =
    deadlineMs === null ? 7 : Math.max(0.25, (deadlineMs - nowMs) / 86_400_000);
  const daysUntilWeeklyReset =
    weeklyResetMs === null ? 7 : Math.max(0.25, (weeklyResetMs - nowMs) / 86_400_000);
  const resetPressure = Math.max(weeklyRemaining - 5, 0) / daysUntilWeeklyReset;
  const pressure = requiredWeeklyBurn / daysUntilDeadline + resetPressure * 0.35;
  const weight = Math.min(6, 1 + pressure / 20);
  const sessionBlocked =
    windows.sessionRemaining !== null &&
    windows.sessionRemaining <= 0 &&
    futureTimestamp(windows.sessionResetAt, nowMs) !== null;

  return {
    connectionId: connection.id,
    weight,
    deadlineAt: deadlineMs === null ? null : new Date(deadlineMs).toISOString(),
    sessionBlocked,
    requiredWeeklyBurn,
  };
}

export function selectCodexDeadlineConnection<T extends CodexDeadlineConnection>(
  connections: readonly T[],
  nowMs = Date.now()
): { connection: T; score: CodexDeadlineScore } | null {
  const scored = connections
    .map((connection) => ({ connection, score: scoreCodexDeadlineConnection(connection, nowMs) }))
    .filter(({ score }) => !score.sessionBlocked);
  if (scored.length === 0) return null;

  return scored.sort((left, right) => {
    const leftLastUsed = timestamp(left.connection.lastUsedAt) ?? nowMs - 86_400_000;
    const rightLastUsed = timestamp(right.connection.lastUsedAt) ?? nowMs - 86_400_000;
    const leftDeficit = Math.max(0, nowMs - leftLastUsed) * left.score.weight;
    const rightDeficit = Math.max(0, nowMs - rightLastUsed) * right.score.weight;
    return (
      rightDeficit - leftDeficit ||
      right.score.weight - left.score.weight ||
      left.connection.priority - right.connection.priority
    );
  })[0];
}
