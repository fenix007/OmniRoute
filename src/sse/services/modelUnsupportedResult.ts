import {
  cooldownUntilMs,
  getModelLockoutInfo,
  isAccountModelUnsupported,
} from "@omniroute/open-sse/services/accountFallback.ts";
import { getAccountModelSupport, type ModelSupportConnection } from "@/lib/db/accountModelSupport";
import * as log from "../utils/logger";

export interface UnsupportedModelConnection {
  id: string;
  httpStatus: number | null;
}

export interface ModelUnsupportedResult {
  modelUnsupported: true;
  unsupportedCount: number;
  unsupportedConnections: UnsupportedModelConnection[];
  lastError: string;
  lastErrorCode: number;
}

export function isModelUnsupportedResult(value: unknown): value is ModelUnsupportedResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      "modelUnsupported" in value &&
      (value as { modelUnsupported?: unknown }).modelUnsupported === true
  );
}

export type CredentialSelectionReturn<T, TOptions> =
  "reportModelUnsupported" extends keyof TOptions
    ? [Extract<TOptions["reportModelUnsupported"], true>] extends [never]
      ? Exclude<T, ModelUnsupportedResult>
      : T
    : Exclude<T, ModelUnsupportedResult>;

export function latestFutureTimestampMs(
  candidates: Array<string | number | null | undefined>,
  now = Date.now()
): number | null {
  let latestMs: number | null = null;
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === "") continue;
    const ms = typeof candidate === "number" ? candidate : cooldownUntilMs(candidate);
    if (Number.isFinite(ms) && ms > now && (latestMs === null || ms > latestMs)) {
      latestMs = ms;
    }
  }
  return latestMs;
}

export function getKnownSupportedCooldownResets(
  provider: string,
  connections: Array<
    ModelSupportConnection & {
      id: string;
      rateLimitedUntil?: string | null;
      providerSpecificData?: Record<string, unknown>;
    }
  >,
  requestedModel: string | null,
  getScopedResetAt?: (
    providerSpecificData: Record<string, unknown>,
    model: string | null
  ) => string | null,
  isRetryableLockout?: (reason: unknown) => boolean,
  getQuotaResets?: (connection: any) => Array<string | null>
): Array<string | null> {
  if (!requestedModel || provider !== "codex") return [];
  const now = Date.now();
  const resets: Array<string | null> = [];
  for (const c of connections) {
    if (getAccountModelSupport(provider, c, requestedModel)?.status !== "supported") continue;
    const lockout = getModelLockoutInfo(provider, c.id, requestedModel);
    const lockoutMs =
      lockout &&
      lockout.remainingMs > 0 &&
      (!isRetryableLockout || isRetryableLockout(lockout.reason))
        ? now + lockout.remainingMs
        : null;
    const latestMs = latestFutureTimestampMs(
      [
        c.rateLimitedUntil || null,
        getScopedResetAt?.(c.providerSpecificData || {}, requestedModel) ?? null,
        lockoutMs,
        ...(getQuotaResets?.(c) ?? []),
      ],
      now
    );
    if (latestMs !== null) resets.push(new Date(latestMs).toISOString());
  }
  return resets;
}

export function findUnsupportedModelEntry(
  provider: string,
  connection: ModelSupportConnection & { id: string },
  requestedModel: string | null
): UnsupportedModelConnection | null {
  if (!requestedModel) return null;
  if (provider === "codex") {
    const support = getAccountModelSupport(provider, connection, requestedModel);
    return support?.status === "unsupported"
      ? { id: connection.id, httpStatus: support.httpStatus ?? null }
      : null;
  }
  return isAccountModelUnsupported(provider, connection.id, requestedModel)
    ? { id: connection.id, httpStatus: 400 }
    : null;
}

export function hasKnownSupportedConnection(
  provider: string,
  connections: Array<ModelSupportConnection & { id: string }>,
  requestedModel: string | null
): boolean {
  if (!requestedModel || provider !== "codex") return false;
  return connections.some(
    (connection) => getAccountModelSupport(provider, connection, requestedModel)?.status === "supported"
  );
}

export function mergeUnsupportedConnections(
  ...lists: Array<UnsupportedModelConnection[] | undefined>
): UnsupportedModelConnection[] {
  const byId = new Map<string, UnsupportedModelConnection>();
  for (const list of lists) {
    if (!list) continue;
    for (const entry of list) {
      const existing = byId.get(entry.id);
      if (!existing || (existing.httpStatus === null && entry.httpStatus !== null)) {
        byId.set(entry.id, entry);
      }
    }
  }
  return Array.from(byId.values());
}

export function buildModelUnsupportedResult(
  provider: string,
  requestedModel: string | null,
  unsupportedConnections: UnsupportedModelConnection[]
): ModelUnsupportedResult {
  const merged = mergeUnsupportedConnections(unsupportedConnections);
  const modelLabel = requestedModel || "requested";
  const allNotFound =
    merged.length > 0 && merged.every((entry) => entry.httpStatus === 404);
  const lastErrorCode = allNotFound ? 404 : 400;
  const lastError = allNotFound
    ? `The model '${modelLabel}' does not exist or you do not have access to it.`
    : provider === "codex"
      ? `The '${modelLabel}' model is not supported when using Codex with a ChatGPT account.`
      : `The '${modelLabel}' model is not supported by any available ${provider} account.`;

  const prefixes = merged
    .slice(0, 6)
    .map((entry) => `${entry.id.slice(0, 8)}...`)
    .join(",");

  log.info(
    "MODEL_DIAGNOSTICS",
    `${provider} | ${merged.length} eligible account(s) rejected ${modelLabel} (${lastErrorCode}): ${prefixes || "none"}`
  );

  return {
    modelUnsupported: true,
    unsupportedCount: merged.length,
    unsupportedConnections: merged,
    lastError,
    lastErrorCode,
  };
}
