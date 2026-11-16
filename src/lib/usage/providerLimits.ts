import {
  getAllProviderLimitsCache,
  getProviderConnectionById,
  getProviderConnections,
  getProviderLimitsCache,
  getSettings,
  resolveProxyForConnection,
  setProviderLimitsCache,
  setProviderLimitsCacheBatch,
  updateProviderConnection,
  updateSettings,
  type ProviderLimitsCacheEntry,
} from "@/lib/localDb";
import { syncToCloud } from "@/lib/cloudSync";
import { setQuotaCache } from "@/domain/quotaCache";
import { buildClaudeExtraUsageConnectionUpdate } from "@/lib/providers/claudeExtraUsage";
import { clearRecoveredProviderState } from "@/sse/services/auth";
import { getMachineId } from "@/shared/utils/machine";
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import { getExecutor } from "@omniroute/open-sse/executors/index.ts";
import { getUsageForProvider } from "@omniroute/open-sse/services/usage.ts";
import {
  rotationGroupFor,
  serializeRefresh,
} from "@omniroute/open-sse/services/refreshSerializer.ts";
import {
  extractCodeAssistOnboardTierId,
  extractCodeAssistSubscriptionTier,
} from "@omniroute/open-sse/services/codeAssistSubscription.ts";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";
import { isUnrecoverableRefreshError } from "@omniroute/open-sse/services/tokenRefresh.ts";
import { fetchQuotaWithProxyRetry } from "./providerLimits/proxyRetry";
import {
  withStatus,
  isQuotaRefreshBlocked,
  recordQuotaRefreshSkipped,
  quotaRefreshSnapshotChanged,
  quotaRefreshCredentials,
  handleRejectedQuotaRefresh,
  quotaCredentialUpdate,
} from "./providerLimits/refreshState";
import {
  isUsageAuthError,
  hasUsableQuota,
  quotaPathShouldMarkExpired,
  isTerminalStatusForQuotaRecovery,
  quotaRecoveryStillBlocked,
  hasTransientQuotaState,
} from "./providerLimits/recoveryPolicy";
export { hasUsableQuota, quotaPathShouldMarkExpired } from "./providerLimits/recoveryPolicy";
import type { JsonRecord, ProviderConnectionLike, SyncSource } from "./providerLimits/types";
import { onUsageRecorded } from "./usageEvents";
import {
  isRecord,
  isUsageQuotaKeyAllowed,
  normalizeUsageQuotasForProvider,
  sanitizeUsageQuotasForProvider,
  toProviderLimitsCacheEntry,
} from "./providerLimits/quotaNormalize";

const PROVIDER_LIMITS_APIKEY_PROVIDERS = new Set([
  "glm",
  "glm-cn",
  "zai",
  "glmt",
  "opencode-go",
  "ollama-cloud",
  "minimax",
  "minimax-cn",
  "crof",
  "nanogpt",
  "deepseek",
  "xiaomi-mimo",
  "vertex",
  "vertex-partner",
  "kimi-coding-apikey",
  "kiro",
  // Qoder connections are PAT-based (authType "apikey"); the usage fetcher
  // exchanges the PAT for a job token and reads openapi.qoder.sh/user/status.
  "qoder",
  // Session cookie stored as the api key; counters from /rest/rate-limit/all.
  "perplexity-web",
]);
const DEFAULT_PROVIDER_LIMITS_SYNC_INTERVAL_MINUTES = 70;
const PROVIDER_LIMITS_AUTO_SYNC_SETTING_KEY = "provider_limits_auto_sync_last_run";
const DEFAULT_PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS = 5_000;
const pendingPostUsageRefreshes = new Set<string>();

function getProviderLimitsPostUsageRefreshDelayMs(): number {
  const raw = Number(process.env.PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS ?? "");
  return Number.isFinite(raw) && raw >= 0
    ? raw
    : DEFAULT_PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS;
}

function scheduleProviderLimitsPostUsageRefresh(connectionId: string): void {
  if (!connectionId || pendingPostUsageRefreshes.has(connectionId)) return;

  pendingPostUsageRefreshes.add(connectionId);
  const timer = setTimeout(() => {
    pendingPostUsageRefreshes.delete(connectionId);
    void fetchAndPersistProviderLimits(connectionId, "scheduled", {
      allowRotatingRefresh: true,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[ProviderLimits] Post-usage refresh failed for connection ${connectionId}: ${message}`
      );
    });
  }, getProviderLimitsPostUsageRefreshDelayMs());
  timer.unref?.();
}

export function notifyProviderUsageRecorded(
  provider: string | null | undefined,
  connectionId: string | null | undefined
): void {
  if ((provider !== "antigravity" && provider !== "agy") || !connectionId) return;
  scheduleProviderLimitsPostUsageRefresh(connectionId);
}

// Subscribe at module load so usageHistory can emit usage events without importing
// this module (and its executors/translator import graph). This module is loaded by
// the provider-limits route and the background auto-sync scheduler at server boot.
onUsageRecorded(notifyProviderUsageRecorded);

function hasRetrieveUserQuotaSource(
  provider: string,
  cache: ProviderLimitsCacheEntry | undefined
): boolean {
  if (provider !== "antigravity" && provider !== "agy") return true;
  if (!cache?.quotas) return false;
  return Object.values(cache.quotas).some((quota) => {
    if (!isRecord(quota)) return false;
    return quota.quotaSource === "retrieveUserQuota";
  });
}

function sanitizeProviderLimitsCacheForConnection(
  connection: ProviderConnectionLike | null | undefined,
  entry: ProviderLimitsCacheEntry | null
): ProviderLimitsCacheEntry | null {
  if (!connection || !entry || !entry.quotas) return entry;
  if (connection.provider !== "antigravity" && connection.provider !== "agy") return entry;

  const sanitizedQuotas = normalizeUsageQuotasForProvider(connection.provider, entry.quotas);
  return sanitizedQuotas === entry.quotas ? entry : { ...entry, quotas: sanitizedQuotas };
}

function shouldRefreshProviderLimitsCache(
  connection: ProviderConnectionLike,
  cache: ProviderLimitsCacheEntry | undefined
): boolean {
  if (!cache?.quotas) return true;
  if (connection.provider !== "antigravity" && connection.provider !== "agy") return false;

  return (
    !hasRetrieveUserQuotaSource(connection.provider, cache) ||
    Object.keys(cache.quotas).some(
      (quotaKey) => !isUsageQuotaKeyAllowed(connection.provider, quotaKey)
    )
  );
}

export function isSupportedUsageConnection(connection: ProviderConnectionLike | null): boolean {
  if (
    !connection ||
    !connection.provider ||
    !USAGE_SUPPORTED_PROVIDERS.includes(connection.provider)
  ) {
    return false;
  }

  if (connection.authType === "oauth") return true;
  return (
    (connection.authType === "apikey" || connection.authType === "api_key") &&
    PROVIDER_LIMITS_APIKEY_PROVIDERS.has(connection.provider)
  );
}

async function syncToCloudIfEnabled() {
  try {
    const machineId = await getMachineId();
    if (!machineId) return;
    await syncToCloud(machineId);
  } catch (error) {
    console.error("[ProviderLimits] Error syncing refreshed credentials to cloud:", error);
  }
}

/**
 * Whether the quota path may refresh this provider's token. Exported for testing.
 *
 * Rotating-refresh providers (Codex/OpenAI share one Auth0 client_id, etc.) mint a
 * single-use refresh_token on every refresh. The BULK quota-sync path runs many
 * connections concurrently; refreshing sibling accounts in parallel makes Auth0
 * revoke the whole token family (openai/codex#9648) and kills every account but
 * the last (#3019). So the bulk path never refreshes rotating providers
 * (`allowRotatingRefresh` falsy). The on-demand, per-connection path opts in and
 * is made safe by `serializeRefresh` (one token mint at a time per rotation group,
 * so even N concurrent per-account requests can never refresh siblings in
 * parallel). Non-rotating providers are always eligible.
 */
export function shouldAttemptRotatingRefresh(
  provider: string,
  allowRotatingRefresh: boolean | undefined
): boolean {
  if (rotationGroupFor(provider) === null) return true;
  return allowRotatingRefresh === true;
}

function skippedQuotaUsage(connection: ProviderConnectionLike): JsonRecord {
  recordQuotaRefreshSkipped(connection);
  const cached = getProviderLimitsCache(connection.id);
  return {
    quotas: cached?.quotas ?? null,
    plan: cached?.plan ?? null,
    message: "Connection is inactive or requires re-authentication; live quota refresh skipped.",
    _refreshSkipped: true,
    _stale: Boolean(cached),
    _staleSince: cached?.fetchedAt ?? null,
  };
}

export async function refreshAndUpdateCredentials(
  connection: ProviderConnectionLike,
  opts: { allowRotatingRefresh?: boolean; force?: boolean } = {}
) {
  if (
    isQuotaRefreshBlocked(connection) ||
    connection.lastErrorType === "unrecoverable_refresh_error"
  ) {
    recordQuotaRefreshSkipped(connection);
    return {
      connection,
      refreshed: false,
      reauthRequired: connection.lastErrorType === "unrecoverable_refresh_error",
    };
  }
  if (!shouldAttemptRotatingRefresh(connection.provider, opts.allowRotatingRefresh)) {
    return { connection, refreshed: false };
  }
  const executor = await getExecutor(connection.provider);
  const credentials = quotaRefreshCredentials(connection);

  // `force` is used ONLY on the reactive 401 recovery path (a usage fetch came
  // back unauthorized) — it bypasses the proactive `needsRefresh` heuristic so
  // imported accounts (expiresAt=null, where needsRefresh is always false) can
  // still re-mint. The mint stays serialized per rotation group; this never
  // refreshes proactively from the bulk path (#3019 guard above is unchanged).
  if (!opts.force && !executor.needsRefresh(credentials)) {
    return { connection, refreshed: false };
  }

  // Serialize the actual token mint per rotation group so two sibling accounts
  // never hit Auth0 concurrently (passthrough for non-rotating providers).
  let skippedConnection: ProviderConnectionLike | null = null;
  const refreshResult = (await serializeRefresh(connection.provider, async () => {
    // The lane may have waited behind another refresh. Recheck before sending secrets.
    const latest = (await getProviderConnectionById(
      connection.id
    )) as unknown as ProviderConnectionLike | null;
    if (!latest) throw withStatus(new Error("Connection not found"), 404);
    if (quotaRefreshSnapshotChanged(latest, connection)) {
      skippedConnection = latest;
      recordQuotaRefreshSkipped(latest);
      return null;
    }
    return executor.refreshCredentials(credentials, console);
  })) as
    | (JsonRecord & {
        accessToken?: string;
        refreshToken?: string;
        expiresIn?: number;
        expiresAt?: string;
        copilotToken?: string;
        copilotTokenExpiresAt?: string;
      })
    | null;

  if (skippedConnection) return { connection: skippedConnection, refreshed: false };

  if (
    isUnrecoverableRefreshError(refreshResult) &&
    new Set(["invalid_client", "unauthorized_client", "invalid_scope"]).has(
      String(refreshResult.code)
    )
  ) {
    // Client configuration failures do not prove that this account's credential is dead.
    if (connection.accessToken) return { connection, refreshed: false };
    throw withStatus(new Error("OAuth client configuration prevented credential refresh."), 502);
  }

  if (isUnrecoverableRefreshError(refreshResult)) {
    return handleRejectedQuotaRefresh(connection);
  }

  if (!refreshResult) {
    // Refresh failed but we still have an accessToken — fall back to the
    // existing token for ANY OAuth provider (graceful degradation) instead of
    // hard-failing. Previously this was qualified to `provider === "github"`,
    // which left every other provider stuck on a transient refresh failure even
    // when a usable access token was still on hand.
    if (connection.accessToken) {
      return { connection, refreshed: false };
    }
    throw withStatus(
      new Error("Failed to refresh credentials. Please re-authorize the connection."),
      401
    );
  }

  const updateData = quotaCredentialUpdate(connection, refreshResult);

  await updateProviderConnection(connection.id, updateData);

  return {
    connection: {
      ...connection,
      ...updateData,
      providerSpecificData:
        (updateData.providerSpecificData as JsonRecord | undefined) ||
        connection.providerSpecificData,
    },
    refreshed: true,
  };
}

function isAccountScopedProxyResolution(proxyInfo: unknown): boolean {
  if (!isRecord(proxyInfo)) return false;
  if (!proxyInfo.proxy) return false;
  return proxyInfo.level === "key" || proxyInfo.level === "account";
}

function shouldFailClosedForProviderLimitsProxy(
  connection: ProviderConnectionLike,
  proxyInfo: unknown
): boolean {
  return connection.authType === "oauth" && isAccountScopedProxyResolution(proxyInfo);
}

export async function maybeClearRecoveredQuotaState(
  connection: ProviderConnectionLike,
  usage: JsonRecord
): Promise<ProviderConnectionLike> {
  if (!hasUsableQuota(usage)) return connection;
  if (isTerminalStatusForQuotaRecovery(connection.testStatus)) return connection;
  // An accepted access token or positive quota does not validate its rejected refresh credential.
  if (connection.lastErrorType === "unrecoverable_refresh_error") return connection;
  if (quotaRecoveryStillBlocked(connection, usage)) return connection;
  const hasTransientState = hasTransientQuotaState(connection);

  if (!hasTransientState) return connection;

  const cleared = await clearRecoveredQuotaSnapshot(connection);

  if (!cleared) {
    // CAS miss — a concurrent writer (markAccountUnavailable, etc.) updated
    // the row between our read and the clear. Return the original snapshot;
    // the next read from DB will surface the fresh state.
    return connection;
  }

  return {
    ...connection,
    testStatus: "active",
    lastError: null,
    lastErrorAt: null,
    lastErrorType: null,
    lastErrorSource: null,
    errorCode: null,
    rateLimitedUntil: null,
    backoffLevel: 0,
  };
}

async function clearRecoveredQuotaSnapshot(connection: ProviderConnectionLike): Promise<boolean> {
  try {
    const result = await clearRecoveredProviderState(
      {
        connectionId: connection.id,
        testStatus: connection.testStatus,
        lastError: connection.lastError ?? null,
        rateLimitedUntil: connection.rateLimitedUntil ?? null,
        errorCode: connection.errorCode ?? null,
        lastErrorType: connection.lastErrorType ?? null,
        lastErrorSource: connection.lastErrorSource ?? null,
      },
      {
        testStatus: connection.testStatus ?? null,
        lastErrorAt: connection.lastErrorAt ?? null,
        rateLimitedUntil: connection.rateLimitedUntil ?? null,
      }
    );
    return result.applied;
  } catch (dbError) {
    console.warn("[ProviderLimits] Failed to clear recovered quota state:", dbError);
    return false;
  }
}

async function syncExpiredStatusIfNeeded(
  connection: ProviderConnectionLike,
  usage: JsonRecord
): Promise<ProviderConnectionLike> {
  if (!quotaPathShouldMarkExpired(connection.provider, usage.message, connection.testStatus)) {
    return connection;
  }

  try {
    await updateProviderConnection(connection.id, {
      testStatus: "expired",
      lastErrorType: "token_expired",
      lastErrorAt: new Date().toISOString(),
    });
  } catch (dbError) {
    console.error("[ProviderLimits] Failed to sync expired status to DB:", dbError);
    return connection;
  }

  return {
    ...connection,
    testStatus: "expired",
    lastErrorType: "token_expired",
  };
}

async function syncClaudeExtraUsageStateIfNeeded(
  connection: ProviderConnectionLike,
  usage: JsonRecord
): Promise<ProviderConnectionLike> {
  const update = buildClaudeExtraUsageConnectionUpdate(connection, usage);
  if (!update) return connection;

  await updateProviderConnection(connection.id, update);
  return {
    ...connection,
    ...update,
  };
}

/** Persist Antigravity tier from live loadCodeAssist on quota refresh (not only OAuth). */
async function syncAntigravitySubscriptionIfNeeded(
  connection: ProviderConnectionLike,
  usage: JsonRecord
): Promise<ProviderConnectionLike> {
  if (connection.provider !== "antigravity" && connection.provider !== "agy") return connection;

  const subscriptionInfo = usage.subscriptionInfo;
  if (!subscriptionInfo) return connection;

  const psd = (connection.providerSpecificData || {}) as JsonRecord;
  const nextPsd: JsonRecord = { ...psd };
  let changed = false;

  const tierId = extractCodeAssistOnboardTierId(subscriptionInfo);
  if (tierId && tierId !== "legacy-tier" && psd.tier !== tierId) {
    nextPsd.tier = tierId;
    changed = true;
  }

  const subscriptionTier = extractCodeAssistSubscriptionTier(subscriptionInfo);
  if (subscriptionTier && psd.subscriptionTier !== subscriptionTier) {
    nextPsd.subscriptionTier = subscriptionTier;
    changed = true;
  }

  const plan = typeof usage.plan === "string" ? usage.plan.trim() : "";
  if (plan && psd.plan !== plan) {
    nextPsd.plan = plan;
    changed = true;
  }

  if (!changed) return connection;

  await updateProviderConnection(connection.id, { providerSpecificData: nextPsd });
  return { ...connection, providerSpecificData: nextPsd };
}

/** Persist refreshed Claude bootstrap fields into psd; writes only on diff. */
async function syncClaudeBootstrapIfNeeded(
  connection: ProviderConnectionLike,
  usage: JsonRecord
): Promise<ProviderConnectionLike> {
  if (connection.provider !== "claude") return connection;
  const bootstrap = usage?.bootstrap as Record<string, string | null> | null | undefined;
  if (!bootstrap || typeof bootstrap !== "object") return connection;

  const psd = (connection.providerSpecificData || {}) as JsonRecord;
  const mapping: Array<[keyof typeof bootstrap, string]> = [
    ["account_uuid", "accountUUID"],
    ["organization_uuid", "organizationUUID"],
    ["organization_name", "organizationName"],
    ["organization_type", "organizationType"],
    ["organization_rate_limit_tier", "organizationRateLimitTier"],
  ];

  const nextPsd: JsonRecord = { ...psd };
  let changed = false;
  for (const [bsKey, psdKey] of mapping) {
    const next = bootstrap[bsKey];
    if (typeof next === "string" && next.length > 0 && psd[psdKey] !== next) {
      nextPsd[psdKey] = next;
      changed = true;
    }
  }

  if (!changed) return connection;

  await updateProviderConnection(connection.id, { providerSpecificData: nextPsd });
  return {
    ...connection,
    providerSpecificData: nextPsd,
  };
}

export function getProviderLimitsSyncIntervalMinutes(): number {
  const raw = Number.parseInt(process.env.PROVIDER_LIMITS_SYNC_INTERVAL_MINUTES ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROVIDER_LIMITS_SYNC_INTERVAL_MINUTES;
}

export function getProviderLimitsSyncIntervalMs(): number {
  return getProviderLimitsSyncIntervalMinutes() * 60 * 1000;
}

/** Default gap (ms) inserted between two consecutive OAuth quota fetches. */
const DEFAULT_PROVIDER_LIMITS_SYNC_SPACING_MS = 1500;

/**
 * Spacing (ms) between consecutive OAuth provider-limits fetches in a bulk sync.
 *
 * OAuth providers (Codex/Claude/Kimi-coding/…) are fetched ONE AT A TIME with
 * this gap so a single host never bursts several simultaneous usage/refresh
 * requests to the same upstream — bursts read as automated traffic and
 * contribute to session termination / anomaly flags (and, for rotating-token
 * providers, to the Auth0 family-revocation race). Stateless API-key providers
 * keep the fast concurrent path. Tunable via `PROVIDER_LIMITS_SYNC_SPACING_MS`;
 * set to `"0"` to opt out.
 */
export function getProviderLimitsSyncSpacingMs(): number {
  const rawEnv = process.env.PROVIDER_LIMITS_SYNC_SPACING_MS;
  if (rawEnv === undefined || rawEnv === "") return DEFAULT_PROVIDER_LIMITS_SYNC_SPACING_MS;
  const raw = Number(rawEnv);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_PROVIDER_LIMITS_SYNC_SPACING_MS;
}

const syncDelay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function getLastProviderLimitsAutoSyncTime(): Promise<string | null> {
  try {
    const settings = await getSettings();
    const value = settings[PROVIDER_LIMITS_AUTO_SYNC_SETTING_KEY];
    return typeof value === "string" && value.trim() ? value : null;
  } catch {
    return null;
  }
}

async function setLastProviderLimitsAutoSyncTime(timestamp: string): Promise<void> {
  await updateSettings({ [PROVIDER_LIMITS_AUTO_SYNC_SETTING_KEY]: timestamp });
}

export function getCachedProviderLimitsMap(): Record<string, ProviderLimitsCacheEntry> {
  return getAllProviderLimitsCache();
}

export async function getSanitizedCachedProviderLimitsMap(): Promise<
  Record<string, ProviderLimitsCacheEntry>
> {
  const caches = getAllProviderLimitsCache();
  // Sanitization only rewrites Antigravity/agy quota keys; every other provider's cache
  // entry is returned untouched (see sanitizeProviderLimitsCacheForConnection). The
  // dashboard polls this on an auto-refresh interval, so avoid the unconditional
  // `SELECT * FROM provider_connections` + per-row credential decryption that the
  // previous implementation paid on every poll: skip the scan entirely when nothing is
  // cached, and otherwise fetch ONLY the Antigravity/agy connections. For any other
  // provider, byId.get(id) is undefined and the entry is returned verbatim — identical
  // output to scanning every active connection, but without decrypting unrelated keys.
  // (LEDGER-2 / #3821-review)
  const connectionIds = Object.keys(caches);
  if (connectionIds.length === 0) return {};

  const sanitizableConnections = [
    ...((await getProviderConnections({
      isActive: true,
      provider: "antigravity",
    })) as unknown as ProviderConnectionLike[]),
    ...((await getProviderConnections({
      isActive: true,
      provider: "agy",
    })) as unknown as ProviderConnectionLike[]),
  ];
  if (sanitizableConnections.length === 0) {
    // No connection can change the cache → return the raw entries unchanged.
    return { ...caches };
  }

  const byId = new Map(sanitizableConnections.map((conn) => [conn.id, conn]));
  const sanitized: Record<string, ProviderLimitsCacheEntry> = {};
  for (const [connectionId, entry] of Object.entries(caches)) {
    sanitized[connectionId] =
      sanitizeProviderLimitsCacheForConnection(byId.get(connectionId), entry) || entry;
  }
  return sanitized;
}

export async function fetchLiveProviderLimits(connectionId: string): Promise<{
  connection: ProviderConnectionLike;
  usage: JsonRecord;
}> {
  return fetchLiveProviderLimitsWithOptions(connectionId, { forceRefresh: false });
}

async function fetchLiveProviderLimitsWithOptions(
  connectionId: string,
  options: { forceRefresh?: boolean; allowRotatingRefresh?: boolean } = {}
): Promise<{
  connection: ProviderConnectionLike;
  usage: JsonRecord;
}> {
  let connection = (await getProviderConnectionById(
    connectionId
  )) as unknown as ProviderConnectionLike | null;
  if (!connection) {
    throw withStatus(new Error("Connection not found"), 404);
  }

  // Quota inspection must not revive or mint credentials for parked/terminal accounts.
  if (isQuotaRefreshBlocked(connection)) {
    return { connection, usage: skippedQuotaUsage(connection) };
  }

  if (!isSupportedUsageConnection(connection)) {
    throw withStatus(new Error("Usage not available for this connection"), 400);
  }

  if (connection.authType !== "oauth") {
    // L3: route the API-key usage/quota fetch through the connection's proxy context,
    // mirroring the OAuth branch below (proxyInfo?.proxy ?? null). Without this, API-key
    // usage egresses on the host IP, ignoring the connection's assigned proxy.
    const apiKeyProxy = await resolveProxyForConnection(connectionId);
    const usage = sanitizeUsageQuotasForProvider(
      connection.provider,
      (await runWithProxyContext(apiKeyProxy?.proxy ?? null, () =>
        getUsageForProvider(connection as unknown as JsonRecord, options)
      )) as JsonRecord
    );
    connection = await applyProviderQuotaState(connection, usage);
    return { connection, usage };
  }

  const proxyInfo = await resolveProxyForConnection(connectionId);

  const fetchUsageWithContext = async (proxyConfig: unknown) =>
    runWithProxyContext(proxyConfig, async () => {
      let conn = connection as ProviderConnectionLike;
      let wasRefreshed = false;

      const result = await refreshAndUpdateCredentials(conn, {
        allowRotatingRefresh: options.allowRotatingRefresh,
      });
      conn = result.connection;
      wasRefreshed = result.refreshed;
      if (isQuotaRefreshBlocked(conn)) return { usage: skippedQuotaUsage(conn) };

      if (wasRefreshed) {
        await syncToCloudIfEnabled();
      }

      let usageData = await fetchSanitizedProviderUsage(conn, options);

      // Reactive 401 recovery (on-demand/force path only): an unauthorized usage
      // response means the access token is actually dead. Force ONE serialized
      // re-mint and retry once. This recovers imported accounts (expiresAt=null,
      // where the proactive needsRefresh heuristic never fires) without ever
      // refreshing proactively from the bulk path.
      if (
        options.allowRotatingRefresh &&
        !wasRefreshed &&
        !result.reauthRequired &&
        isUsageAuthError(usageData?.message)
      ) {
        const forced = await refreshAndUpdateCredentials(conn, {
          allowRotatingRefresh: true,
          force: true,
        });
        if (forced.refreshed) {
          conn = forced.connection;
          await syncToCloudIfEnabled();
          usageData = await fetchSanitizedProviderUsage(conn, options);
        }
      }

      connection = conn;
      return { usage: usageData };
    });

  const result = await fetchQuotaWithProxyRetry(
    connection,
    proxyInfo,
    shouldFailClosedForProviderLimitsProxy(connection, proxyInfo),
    fetchUsageWithContext
  );

  connection = await applyProviderQuotaState(connection, result.usage);

  return {
    connection,
    usage: result.usage,
  };
}

async function applyProviderQuotaState(
  connection: ProviderConnectionLike,
  usage: JsonRecord
): Promise<ProviderConnectionLike> {
  if (isRecord(usage.quotas)) {
    setQuotaCache(connection.id, connection.provider, usage.quotas);
  }
  connection = await syncExpiredStatusIfNeeded(connection, usage);
  connection = await syncClaudeExtraUsageStateIfNeeded(connection, usage);
  connection = await syncClaudeBootstrapIfNeeded(connection, usage);
  connection = await syncAntigravitySubscriptionIfNeeded(connection, usage);
  connection = await maybeClearRecoveredQuotaState(connection, usage);
  return connection;
}

export async function fetchAndPersistProviderLimits(
  connectionId: string,
  source: SyncSource = "manual",
  opts: { allowRotatingRefresh?: boolean } = {}
): Promise<{
  connection: ProviderConnectionLike;
  usage: JsonRecord;
  cache: ProviderLimitsCacheEntry;
}> {
  const { connection, usage } = await fetchLiveProviderLimitsWithOptions(connectionId, {
    forceRefresh: source === "manual",
    allowRotatingRefresh: opts.allowRotatingRefresh,
  });
  const newCache = toProviderLimitsCacheEntry(usage, source);
  if (usage._refreshSkipped === true) {
    return { connection, usage, cache: getProviderLimitsCache(connectionId) || newCache };
  }

  // Don't persist error-only entries (429 etc.) — would wipe prior good cache.
  // Serve the prior entry instead; only successful fetches update the cache.
  const fetchFailed = !newCache.quotas && newCache.message;
  if (fetchFailed) {
    const previous = getProviderLimitsCache(connectionId);
    if (previous?.quotas && Object.keys(previous.quotas).length > 0) {
      const staleUsage: JsonRecord = {
        ...usage,
        quotas: previous.quotas,
        plan: previous.plan ?? usage.plan ?? null,
        bankedResetCredits: previous.bankedResetCredits,
        message: null,
        _stale: true,
        _staleSince: previous.fetchedAt,
        _staleReason: newCache.message,
      };
      return { connection, usage: staleUsage, cache: previous };
    }
    return { connection, usage, cache: newCache };
  }

  setProviderLimitsCache(connectionId, newCache);
  return { connection, usage, cache: newCache };
}

export async function syncAllProviderLimits(
  options: {
    source?: SyncSource;
    concurrency?: number;
  } = {}
): Promise<{
  total: number;
  succeeded: number;
  failed: number;
  caches: Record<string, ProviderLimitsCacheEntry>;
  errors: Record<string, string>;
}> {
  const { source = "manual", concurrency = 5 } = options;
  const connections = (
    (await getProviderConnections({ isActive: true })) as unknown as ProviderConnectionLike[]
  ).filter(isSupportedUsageConnection);
  const cacheEntries: Array<{ connectionId: string; entry: ProviderLimitsCacheEntry }> = [];
  const caches: Record<string, ProviderLimitsCacheEntry> = {};
  const errors: Record<string, string> = {};

  const fetchOne = async (connection: ProviderConnectionLike) => {
    const existingCache = getProviderLimitsCache(connection.id);
    const forceRefresh =
      source === "manual" ||
      shouldRefreshProviderLimitsCache(connection, existingCache || undefined);
    const { usage } = await fetchLiveProviderLimitsWithOptions(connection.id, {
      forceRefresh,
    });
    const cache = toProviderLimitsCacheEntry(usage, source);
    return { connectionId: connection.id, cache };
  };

  // OAuth connections are processed STRICTLY SEQUENTIALLY with a spacing gap so a
  // single host never bursts simultaneous usage/refresh requests to the same
  // upstream (anomaly/session-termination guard; see getProviderLimitsSyncSpacingMs).
  // Stateless API-key connections keep the fast chunked-concurrent path.
  const oauthConnections = connections.filter((c) => c.authType === "oauth");
  const otherConnections = connections.filter((c) => c.authType !== "oauth");
  const spacingMs = getProviderLimitsSyncSpacingMs();

  for (let i = 0; i < otherConnections.length; i += concurrency) {
    const chunk = otherConnections.slice(i, i + concurrency);
    const results = await Promise.allSettled(chunk.map(fetchOne));
    results.forEach((result, index) => {
      const connectionId = chunk[index]?.id;
      if (connectionId)
        recordProviderQuotaResult(connectionId, result, cacheEntries, caches, errors);
    });
  }

  for (let i = 0; i < oauthConnections.length; i++) {
    const connection = oauthConnections[i];
    const [result] = await Promise.allSettled([fetchOne(connection)]);
    recordProviderQuotaResult(connection.id, result, cacheEntries, caches, errors);
    if (spacingMs > 0 && i < oauthConnections.length - 1) {
      await syncDelay(spacingMs);
    }
  }

  if (cacheEntries.length > 0) {
    setProviderLimitsCacheBatch(cacheEntries);
  }

  if (source === "scheduled") {
    await setLastProviderLimitsAutoSyncTime(new Date().toISOString());
  }

  return {
    total: connections.length,
    succeeded: cacheEntries.length,
    failed: connections.length - cacheEntries.length,
    caches,
    errors,
  };
}

function recordProviderQuotaResult(
  connectionId: string,
  result: PromiseSettledResult<{ connectionId: string; cache: ProviderLimitsCacheEntry }>,
  cacheEntries: Array<{ connectionId: string; entry: ProviderLimitsCacheEntry }>,
  caches: Record<string, ProviderLimitsCacheEntry>,
  errors: Record<string, string>
) {
  if (result.status === "fulfilled") {
    const { cache } = result.value;
    // Don't persist error-only entries; show prior cache or pass through.
    if (!cache.quotas && cache.message) {
      const previous = getProviderLimitsCache(connectionId);
      if (previous?.quotas && Object.keys(previous.quotas).length > 0) {
        caches[connectionId] = previous;
      } else {
        caches[connectionId] = cache;
      }
      return;
    }
    cacheEntries.push({ connectionId, entry: cache });
    caches[connectionId] = cache;
    return;
  }
  const reason = result.reason as { message?: string } | undefined;
  errors[connectionId] = reason?.message || "Failed to refresh provider limits";
}

async function fetchSanitizedProviderUsage(
  connection: ProviderConnectionLike,
  options: { forceRefresh?: boolean; allowRotatingRefresh?: boolean }
): Promise<JsonRecord> {
  return sanitizeUsageQuotasForProvider(
    connection.provider,
    (await getUsageForProvider(connection as unknown as JsonRecord, options)) as JsonRecord
  );
}
