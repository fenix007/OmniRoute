/**
 * Codex "quota-deadline" account routing.
 *
 * Goal: spend quota that is about to be lost before quota that is not. Each
 * account carries one or more *buckets* of quota, and every bucket has a moment
 * after which the quota inside it is gone for good:
 *
 *   - the weekly window, lost at the weekly reset (or earlier, when the paid
 *     subscription ends first);
 *   - banked reset credits, each lost at its own expiry (again capped by the
 *     end of the subscription).
 *
 * Each bucket contributes its own required burn rate, in percentage points
 * per day. The account's urgency is their sum, so even one reset credit with
 * a later expiry adds pressure instead of being hidden by a nearer weekly
 * reset. Subscription expiry caps each bucket's deadline independently.
 */

import { getQuotaCache } from "@/domain/quotaCache";
import { getCachedCodexResetCredits } from "@/lib/usage/codexResetCreditCache";
import { getCachedCodexQuota } from "@omniroute/open-sse/services/codexQuotaFetcher.ts";

type JsonRecord = Record<string, unknown>;

export interface CodexDeadlineConnection {
  id: string;
  priority: number;
  lastUsedAt: string | null;
  providerSpecificData: JsonRecord;
}

/** Where a connection's weight came from — reported so logs stay honest. */
export type CodexDeadlineWeightSource = "measured" | "pool-median";

export interface CodexDeadlineScore {
  connectionId: string;
  weight: number;
  deadlineAt: string | null;
  sessionBlocked: boolean;
  requiredWeeklyBurn: number;
  /** False when no weekly window is cached: unknown headroom, not zero headroom. */
  weeklyKnown: boolean;
  /** Session reports no headroom but its reset is missing or already past. */
  sessionDepleted: boolean;
  /** A subscription end date exists but is already in the past. */
  subscriptionExpired: boolean;
  weightSource: CodexDeadlineWeightSource;
}

/** Headroom kept in reserve, in percentage points, so an account never runs dry. */
const RESERVE_PERCENT = 5;

/** Percentage points a redeemed reset credit is worth. */
const CREDIT_PERCENT = 95;

/** Horizon used when nothing tells us when the quota expires. */
const DEFAULT_HORIZON_DAYS = 7;

/** Deadlines closer than this collapse together; keeps the rate finite. */
const MIN_HORIZON_DAYS = 0.25;

/** Percentage points per day that map to one extra unit of weight. */
const RATE_PER_WEIGHT_UNIT = 20;

const MAX_WEIGHT = 6;

const DAY_MS = 86_400_000;

/** Idle time assumed for a connection that has never been used. */
const UNUSED_IDLE_MS = DAY_MS;

interface QuotaBucket {
  /** Percentage points that vanish at `deadlineMs`. */
  amount: number;
  /** Null when we do not know when this quota is lost. */
  deadlineMs: number | null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

/** Earliest of the given moments, ignoring the unknown ones. */
function earliest(...values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? Math.min(...known) : null;
}

function daysUntil(deadlineMs: number | null, nowMs: number): number {
  if (deadlineMs === null) return DEFAULT_HORIZON_DAYS;
  return Math.max(MIN_HORIZON_DAYS, (deadlineMs - nowMs) / DAY_MS);
}

/**
 * Remaining headroom of one cached window, in percentage points.
 *
 * The two caches disagree on units: the domain cache stores
 * `remainingPercentage` on a 0-100 scale, while the codex fetcher stores
 * `percentUsed` as a 0-1 fraction (`codexQuotaFetcher.ts::parseCodexWindow`),
 * so the fraction has to be scaled before it is subtracted.
 */
function windowRemaining(window: unknown): number | null {
  if (!window || typeof window !== "object") return null;

  const record = window as JsonRecord;
  if ("remainingPercentage" in record) {
    return finiteNumber(record.remainingPercentage);
  }

  const percentUsed = finiteNumber(record.percentUsed);
  return percentUsed === null ? null : 100 - percentUsed * 100;
}

function windowResetAt(window: unknown): unknown {
  if (!window || typeof window !== "object") return null;
  return (window as JsonRecord).resetAt ?? null;
}

function cachedWindows(connectionId: string) {
  const domain = getQuotaCache(connectionId);
  const dedicated = getCachedCodexQuota(connectionId);
  const session = domain?.quotas?.session ?? dedicated?.window5h ?? null;
  const weekly = domain?.quotas?.weekly ?? dedicated?.window7d ?? null;
  return {
    sessionRemaining: windowRemaining(session),
    sessionResetAt: windowResetAt(session),
    weeklyRemaining: windowRemaining(weekly),
    weeklyResetAt: windowResetAt(weekly),
    bankedResetCredits: finiteNumber(dedicated?.bankedResetCredits),
  };
}

/** Sum the deadline pressure of every bucket so no spendable credit is hidden. */
function requiredBurnRate(buckets: readonly QuotaBucket[], nowMs: number): number {
  return buckets.reduce(
    (rate, bucket) => rate + Math.max(0, bucket.amount) / daysUntil(bucket.deadlineMs, nowMs),
    0
  );
}

export function scoreCodexDeadlineConnection(
  connection: CodexDeadlineConnection,
  nowMs = Date.now()
): CodexDeadlineScore {
  const windows = cachedWindows(connection.id);
  const cachedCredits = getCachedCodexResetCredits(connection.id);

  const subscriptionEndsAt = timestamp(connection.providerSpecificData.subscriptionActiveUntil);
  const subscriptionDeadlineMs =
    subscriptionEndsAt !== null && subscriptionEndsAt > nowMs ? subscriptionEndsAt : null;

  const weeklyKnown = windows.weeklyRemaining !== null;
  const weeklyRemaining = Math.max(0, Math.min(100, windows.weeklyRemaining ?? 0));
  const weeklyResetMs = futureTimestamp(windows.weeklyResetAt, nowMs);

  const creditCount =
    finiteNumber(cachedCredits?.availableCount) ?? windows.bankedResetCredits ?? 0;
  const resetCredits = Math.max(0, Math.trunc(creditCount));
  const creditExpiryMs = earliest(
    ...(cachedCredits?.credits ?? []).map((credit) => futureTimestamp(credit.expiresAt, nowMs))
  );

  // The weekly window is lost at its reset, or when the subscription ends if
  // that happens first. Credits keep their own expiry, capped the same way.
  const buckets: QuotaBucket[] = [
    {
      amount: weeklyKnown ? Math.max(weeklyRemaining - RESERVE_PERCENT, 0) : 0,
      deadlineMs: earliest(weeklyResetMs, subscriptionDeadlineMs),
    },
    {
      amount: CREDIT_PERCENT * resetCredits,
      deadlineMs: earliest(creditExpiryMs, subscriptionDeadlineMs),
    },
  ];

  const requiredWeeklyBurn = buckets.reduce((total, bucket) => total + bucket.amount, 0);
  const weight = Math.min(MAX_WEIGHT, 1 + requiredBurnRate(buckets, nowMs) / RATE_PER_WEIGHT_UNIT);

  const deadlineMs = earliest(
    ...buckets.filter((bucket) => bucket.amount > 0).map((bucket) => bucket.deadlineMs)
  );

  const sessionEmpty = windows.sessionRemaining !== null && windows.sessionRemaining <= 0;
  const sessionResetMs = futureTimestamp(windows.sessionResetAt, nowMs);

  return {
    connectionId: connection.id,
    weight,
    deadlineAt: deadlineMs === null ? null : new Date(deadlineMs).toISOString(),
    // An exhausted session with a known reset is unusable until that reset. An
    // exhausted session whose reset is missing or already past may simply be a
    // stale reading, so it stays eligible but sorts last (`sessionDepleted`).
    sessionBlocked: sessionEmpty && sessionResetMs !== null,
    requiredWeeklyBurn,
    weeklyKnown,
    sessionDepleted: sessionEmpty && sessionResetMs === null,
    subscriptionExpired: subscriptionEndsAt !== null && subscriptionDeadlineMs === null,
    weightSource: "measured",
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * An account with no cached weekly window has *unknown* headroom, which the
 * measured formula cannot tell apart from *no* headroom — both score the
 * minimum weight, so accounts we know least about would always be starved.
 * Neither extreme is safe to assume, so they take the pool's median urgency:
 * neutral relative to their peers, and no capacity is invented.
 */
function neutralizeUnknownWeights(scored: ReadonlyArray<{ score: CodexDeadlineScore }>): void {
  const measured = scored.filter(({ score }) => score.weeklyKnown).map(({ score }) => score.weight);
  const poolMedian = median(measured);
  if (poolMedian === null) return;

  for (const { score } of scored) {
    if (score.weeklyKnown) continue;
    score.weight = poolMedian;
    score.weightSource = "pool-median";
  }
}

export function selectCodexDeadlineConnection<T extends CodexDeadlineConnection>(
  connections: readonly T[],
  nowMs = Date.now()
): { connection: T; score: CodexDeadlineScore } | null {
  const scored = connections
    .map((connection) => ({ connection, score: scoreCodexDeadlineConnection(connection, nowMs) }))
    .filter(({ score }) => !score.sessionBlocked);
  if (scored.length === 0) return null;

  neutralizeUnknownWeights(scored);

  return scored.sort((left, right) => {
    if (left.score.sessionDepleted !== right.score.sessionDepleted) {
      return left.score.sessionDepleted ? 1 : -1;
    }
    const leftLastUsed = timestamp(left.connection.lastUsedAt) ?? nowMs - UNUSED_IDLE_MS;
    const rightLastUsed = timestamp(right.connection.lastUsedAt) ?? nowMs - UNUSED_IDLE_MS;
    const leftDeficit = Math.max(0, nowMs - leftLastUsed) * left.score.weight;
    const rightDeficit = Math.max(0, nowMs - rightLastUsed) * right.score.weight;
    return (
      rightDeficit - leftDeficit ||
      right.score.weight - left.score.weight ||
      left.connection.priority - right.connection.priority ||
      left.connection.id.localeCompare(right.connection.id)
    );
  })[0];
}
