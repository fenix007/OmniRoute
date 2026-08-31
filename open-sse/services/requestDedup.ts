/**
 * Request Deduplication Service
 *
 * Deduplicates **concurrent** identical requests to the same upstream.
 * Inspired by ClawRouter's dedup.ts (BlockRunAI / github.com/BlockRunAI/ClawRouter).
 *
 * IMPORTANT: In-memory only — does NOT persist across restarts and does NOT
 * work across multiple process instances (no cross-instance dedup).
 */

import { createHash } from "node:crypto";

const MAX_INFLIGHT = 1000;

export interface DedupConfig {
  enabled: boolean;
  maxTemperatureForDedup: number;
  timeoutMs: number;
}

export const DEFAULT_DEDUP_CONFIG: DedupConfig = {
  enabled: true,
  maxTemperatureForDedup: 0.1,
  timeoutMs: 60_000,
};

export interface DedupResult<T> {
  result: T;
  wasDeduplicated: boolean;
  hash: string;
}

const inflight = new Map<string, Promise<unknown>>();

const NON_OUTPUT_TOP_LEVEL_FIELDS = new Set(["stream", "user", "metadata"]);

function stableCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableCanonicalize);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, stableCanonicalize(record[key])])
  );
}

/**
 * Compute a deterministic hash for a request body.
 * Hashes the complete translated upstream body except top-level transport/client
 * metadata that cannot affect model output. The handler calls this after translation,
 * where prompt-bearing fields vary by provider (`messages`, `input`, `contents`, and
 * nested envelopes); projecting only Chat Completions fields can therefore collide
 * different prompts or structured-output schemas onto one shared response.
 *
 * `tenantId` namespaces the hash because a shared in-flight execution uses the
 * owner's provider connection, policy, and billing context. Anonymous local mode
 * keeps the un-namespaced form.
 */
export function computeRequestHash(requestBody: unknown, tenantId?: string | null): string {
  const body =
    requestBody && typeof requestBody === "object" && !Array.isArray(requestBody)
      ? (requestBody as Record<string, unknown>)
      : {};
  const outputAffectingBody = Object.fromEntries(
    Object.entries(body).filter(([key]) => !NON_OUTPUT_TOP_LEVEL_FIELDS.has(key))
  );
  const canonical = JSON.stringify(stableCanonicalize(outputAffectingBody));
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return tenantId ? `${tenantId}.${digest}` : digest;
}

/** Determine whether a request should be deduplicated */
export function shouldDeduplicate(
  requestBody: unknown,
  config: DedupConfig = DEFAULT_DEDUP_CONFIG
): boolean {
  if (!config.enabled) return false;
  const body = requestBody as Record<string, unknown>;
  if (body.stream === true) return false;
  const temperature = typeof body.temperature === "number" ? body.temperature : 1.0;
  if (temperature > config.maxTemperatureForDedup) return false;
  return true;
}

/**
 * Execute a request with deduplication.
 * Concurrent identical requests share one upstream call.
 */
export async function deduplicate<T>(
  hash: string,
  fn: () => Promise<T>,
  config: DedupConfig = DEFAULT_DEDUP_CONFIG
): Promise<DedupResult<T>> {
  if (!config.enabled) {
    return { result: await fn(), wasDeduplicated: false, hash };
  }

  const existing = inflight.get(hash);
  if (existing) {
    try {
      const result = (await existing) as T;
      return { result, wasDeduplicated: true, hash };
    } catch {
      // The owner failed before producing a response (fetch rejection, timeout,
      // abort, etc.). A waiter must make its own attempt instead of inheriting
      // the same transport failure.
      return { result: await fn(), wasDeduplicated: false, hash };
    }
  }

  if (inflight.size >= MAX_INFLIGHT) {
    const oldestKey = inflight.keys().next().value;
    if (oldestKey !== undefined) inflight.delete(oldestKey);
  }

  const sharedPromise = Promise.resolve().then(fn);
  inflight.set(hash, sharedPromise as Promise<unknown>);

  const timer = setTimeout(() => {
    if (inflight.get(hash) === sharedPromise) inflight.delete(hash);
  }, config.timeoutMs);

  try {
    const result = await sharedPromise;
    return { result, wasDeduplicated: false, hash };
  } finally {
    clearTimeout(timer);
    if (inflight.get(hash) === sharedPromise) inflight.delete(hash);
  }
}

export function getInflightCount(): number {
  return inflight.size;
}
export function getInflightHashes(): string[] {
  return [...inflight.keys()];
}
export function clearInflight(): void {
  inflight.clear();
}
