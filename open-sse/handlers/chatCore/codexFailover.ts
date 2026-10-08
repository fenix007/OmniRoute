import { getCodexModelScope } from "../../config/codexQuotaScopes.ts";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/db/providers";
import {
  parseSessionRouting,
  type SessionRouting,
  type SessionSource,
} from "@/lib/usage/sessionRouting";

type CodexFailoverCredentials = {
  connectionId?: string | null;
  providerSpecificData?: unknown;
};

function asProviderData(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function buildCodexFailoverSelectionContext(params: {
  initialSessionRouting: SessionRouting | null;
  failedConnectionId: string | null;
  allowedConnectionIds: unknown;
}): {
  canRotate: boolean;
  sessionKey: string | null;
  sessionSource: SessionSource;
  previousConnectionId: string | null;
  allowedConnectionIds: string[] | null;
} {
  const routing = parseSessionRouting(params.initialSessionRouting);
  const hasAuthoritativePolicy = params.allowedConnectionIds !== undefined;
  const unrestricted = params.allowedConnectionIds === null;
  const allowedConnectionIds = Array.isArray(params.allowedConnectionIds)
    ? [
        ...new Set(
          params.allowedConnectionIds.filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0
          )
        ),
      ]
    : [];
  return {
    canRotate: hasAuthoritativePolicy && (unrestricted || allowedConnectionIds.length > 0),
    sessionKey: routing?.sessionHash ? `session:sha256:${routing.sessionHash}` : null,
    sessionSource: routing?.sessionSource ?? "none",
    previousConnectionId: params.failedConnectionId,
    allowedConnectionIds: unrestricted ? null : allowedConnectionIds,
  };
}

export function applyCodexFailoverCredentials(
  credentials: Record<string, unknown>,
  nextCredentials: Record<string, unknown>,
  currentSessionRouting: SessionRouting | null
): SessionRouting | null {
  const nextSessionRouting =
    parseSessionRouting(nextCredentials.sessionRouting) ?? currentSessionRouting;
  Object.assign(credentials, nextCredentials, { sessionRouting: nextSessionRouting });
  return nextSessionRouting;
}

export async function markCodexScopeRateLimited(params: {
  failedConnectionId: string;
  model: string | null;
  rateLimitedUntil: string;
  credentials?: CodexFailoverCredentials | null;
}): Promise<void> {
  const connection = await getProviderConnectionById(params.failedConnectionId).catch(() => null);
  const existingProviderData = connection
    ? asProviderData(connection.providerSpecificData)
    : asProviderData(params.credentials?.providerSpecificData);
  const existingScopeMap = asProviderData(existingProviderData.codexScopeRateLimitedUntil);
  const nextProviderData = {
    ...existingProviderData,
    codexScopeRateLimitedUntil: {
      ...existingScopeMap,
      [getCodexModelScope(params.model || "")]: params.rateLimitedUntil,
    },
  };

  updateProviderConnection(params.failedConnectionId, {
    ...(connection ? { providerSpecificData: nextProviderData } : {}),
    lastError: "429 rate limited — codex account rotation",
    errorCode: 429,
  }).catch(() => {});

  if (params.credentials && String(params.credentials.connectionId) === params.failedConnectionId) {
    params.credentials.providerSpecificData = nextProviderData;
  }
}
