import {
  markConnectionRefreshRejectedIfUnchanged,
  getProviderConnectionById,
} from "@/lib/db/providers";
import { recordKiroRefreshDiagnostic } from "@omniroute/open-sse/services/tokenRefreshUtils.ts";
import type { JsonRecord, ProviderConnectionLike } from "./types";

export function withStatus(error: Error, status: number): Error & { status: number } {
  return Object.assign(error, { status });
}

const QUOTA_REFRESH_TERMINAL_STATUSES = new Set(["banned", "expired", "deactivated"]);

export function isQuotaRefreshBlocked(connection: ProviderConnectionLike): boolean {
  return (
    connection.isActive === false || QUOTA_REFRESH_TERMINAL_STATUSES.has(connection.testStatus)
  );
}

export function recordQuotaRefreshSkipped(connection: ProviderConnectionLike): void {
  if (connection.provider === "kiro") {
    recordKiroRefreshDiagnostic({ connectionId: connection.id, source: "quota" }, "skipped");
  }
}

export function quotaRefreshSnapshotChanged(
  latest: ProviderConnectionLike,
  original: ProviderConnectionLike
): boolean {
  return Boolean(
    latest &&
    (isQuotaRefreshBlocked(latest) ||
      latest.refreshToken !== original.refreshToken ||
      (latest.accessToken || "") !== (original.accessToken || ""))
  );
}

export function quotaRefreshCredentials(connection: ProviderConnectionLike) {
  return {
    connectionId: connection.id,
    refreshSource: "quota" as const,
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    expiresAt: connection.tokenExpiresAt || connection.expiresAt || null,
    providerSpecificData: connection.providerSpecificData,
    copilotToken: connection.providerSpecificData?.copilotToken,
    copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
  };
}

export async function handleRejectedQuotaRefresh(connection: ProviderConnectionLike) {
  // A refresh can overlap re-authentication or another writer. Never mark its newer
  // credentials invalid because the older snapshot was rejected upstream.
  const latest = (await getProviderConnectionById(
    connection.id
  )) as unknown as ProviderConnectionLike | null;
  if (!latest) throw withStatus(new Error("Connection not found"), 404);
  if (quotaRefreshSnapshotChanged(latest, connection)) {
    return { connection: latest, refreshed: false };
  }
  const current = latest || connection;
  const expiry = Date.parse(current.tokenExpiresAt || current.expiresAt || "");
  const accessTokenStillValid =
    Boolean(current.accessToken) && Number.isFinite(expiry) && expiry > Date.now();
  if (latest?.updatedAt) {
    const applied = markConnectionRefreshRejectedIfUnchanged(
      connection.id,
      latest.updatedAt,
      accessTokenStillValid
    );
    if (!applied) {
      return {
        connection: ((await getProviderConnectionById(connection.id)) ||
          current) as ProviderConnectionLike,
        refreshed: false,
      };
    }
  }
  if (accessTokenStillValid) {
    return {
      connection: { ...current, lastErrorType: "unrecoverable_refresh_error" },
      refreshed: false,
      reauthRequired: true,
    };
  }
  throw withStatus(
    new Error("Refresh credential rejected. Please re-authenticate this account."),
    401
  );
}

export function quotaCredentialUpdate(
  connection: ProviderConnectionLike,
  refreshResult: JsonRecord & { expiresIn?: number }
) {
  const updateData: JsonRecord = {
    updatedAt: new Date().toISOString(),
  };

  if (refreshResult.accessToken) {
    updateData.accessToken = refreshResult.accessToken;
  }
  if (refreshResult.refreshToken) {
    updateData.refreshToken = refreshResult.refreshToken;
  }
  if (refreshResult.expiresIn) {
    const expiresAt = new Date(Date.now() + refreshResult.expiresIn * 1000).toISOString();
    updateData.expiresAt = expiresAt;
    updateData.tokenExpiresAt = expiresAt;
  } else if (refreshResult.expiresAt) {
    updateData.expiresAt = refreshResult.expiresAt;
    updateData.tokenExpiresAt = refreshResult.expiresAt;
  }
  if (refreshResult.copilotToken || refreshResult.copilotTokenExpiresAt) {
    updateData.providerSpecificData = {
      ...(connection.providerSpecificData || {}),
      copilotToken: refreshResult.copilotToken,
      copilotTokenExpiresAt: refreshResult.copilotTokenExpiresAt,
    };
  }

  return updateData;
}
