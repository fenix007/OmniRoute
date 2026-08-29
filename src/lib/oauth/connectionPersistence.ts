/**
 * Shared upsert for OAuth provider connections, used by both the authenticated
 * OAuth route (`device-complete`) and the public Codex device-flow completion
 * endpoint. Mirrors the exchange/poll/poll-callback persistence: normalize the
 * display name, compute expiry, match an existing connection by id or email
 * (+ Codex workspaceId) and update it, else create a new one, then sync to Cloud.
 */
import { timingSafeEqual } from "crypto";
import {
  createProviderConnection,
  updateProviderConnection,
  getProviderConnections,
  isCloudEnabled,
} from "@/models";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { syncToCloud } from "@/lib/cloudSync";

/**
 * Constant-time string comparison to prevent timing-oracle attacks (CWE-208).
 * Handles null/undefined safely and different-length strings.
 */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a === b;
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Decide whether two Codex OAuth payloads identify the same account. Team
 * accounts are keyed by workspace; personal accounts without a workspace must
 * agree on ChatGPT user id because email alone is not a unique account key.
 */
function isSameCodexAccount(
  existingProviderData: Record<string, any> | null | undefined,
  incomingProviderData: Record<string, any> | null | undefined
): boolean {
  const incomingWorkspace = incomingProviderData?.workspaceId;
  const existingWorkspace = existingProviderData?.workspaceId;
  if (incomingWorkspace || existingWorkspace) {
    return safeEqual(existingWorkspace, incomingWorkspace);
  }

  const incomingUserId = incomingProviderData?.chatgptUserId;
  const existingUserId = existingProviderData?.chatgptUserId;
  return Boolean(incomingUserId) && safeEqual(existingUserId, incomingUserId);
}

/**
 * Find the OAuth connection that should receive refreshed credentials. An
 * explicit connection id remains authoritative; otherwise matching falls back
 * to provider-specific account identity rules.
 */
export function findExistingOAuthConnectionMatch(
  existing: Array<Record<string, any>>,
  provider: string,
  tokenData: Record<string, any>,
  connectionId?: string
): Record<string, any> | undefined {
  return existing.find((connection) => {
    if (connection.id && safeEqual(connectionId, connection.id)) return true;
    if (!safeEqual(connection.email, tokenData.email) || connection.authType !== "oauth") {
      return false;
    }
    if (provider === "codex") {
      return isSameCodexAccount(connection.providerSpecificData, tokenData.providerSpecificData);
    }
    return true;
  });
}

/**
 * Build the create payload for a brand-new OAuth connection.
 *
 * #5326: mirror the freshly computed `expiresAt` into `tokenExpiresAt` at creation
 * time. The dashboard token-health badge prefers `tokenExpiresAt` over `expiresAt`
 * (ConnectionRow.tsx: `connection.tokenExpiresAt || connection.expiresAt`). If
 * `tokenExpiresAt` stays null on a freshly created connection, the badge falls back
 * to the original grant clock and can flash a false amber/"Token Expired" until the
 * first background refresh writes both fields together. All refresh paths already
 * persist `expiresAt` and `tokenExpiresAt` in lockstep
 * (tokenHealthCheck onPersist, tokenRefresh.updateProviderCredentials); this makes
 * creation consistent with them.
 */
export function buildOAuthConnectionCreatePayload(
  provider: string,
  tokenData: Record<string, any>,
  expiresAt: string | null
) {
  return {
    provider,
    authType: "oauth" as const,
    ...tokenData,
    expiresAt,
    tokenExpiresAt: expiresAt,
    testStatus: "active" as const,
  };
}

async function syncToCloudIfEnabled(): Promise<void> {
  try {
    const cloudEnabled = await isCloudEnabled();
    if (!cloudEnabled) return;
    const machineId = await getConsistentMachineId();
    await syncToCloud(machineId);
  } catch (error) {
    console.log("Error syncing to cloud after OAuth:", error);
  }
}

export async function persistOAuthConnection(
  provider: string,
  tokenData: any,
  connectionId?: string,
  options: { allowImplicitMatch?: boolean } = {}
) {
  // Normalize: if name is missing, use email or displayName as fallback label.
  if (!tokenData.name && (tokenData.email || tokenData.displayName)) {
    tokenData.name = tokenData.email || tokenData.displayName;
  }

  const expiresAt = tokenData.expiresIn
    ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
    : null;

  let connection: any;
  if (tokenData.email) {
    const existing = await getProviderConnections({ provider });
    const match =
      options.allowImplicitMatch === false
        ? existing.find((candidate: any) =>
            candidate.id ? safeEqual(connectionId, candidate.id) : false
          )
        : findExistingOAuthConnectionMatch(existing, provider, tokenData, connectionId);
    const matchId = typeof match?.id === "string" ? match.id : null;
    if (matchId) {
      connection = await updateProviderConnection(matchId, {
        ...tokenData,
        expiresAt,
        testStatus: "active",
        isActive: true,
      });
    }
  }
  if (!connection) {
    connection = await createProviderConnection(
      buildOAuthConnectionCreatePayload(provider, tokenData, expiresAt),
      { skipOAuthDedup: options.allowImplicitMatch === false }
    );
  }

  await syncToCloudIfEnabled();
  return connection;
}
