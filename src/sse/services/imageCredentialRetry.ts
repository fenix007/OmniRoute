import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

import { getProviderCredentialsWithQuotaPreflight } from "./auth";
import { checkAndRefreshToken } from "./tokenRefresh";
import * as log from "../utils/logger";

interface ImageGenerationResult {
  success: boolean;
  status?: number;
  error?: unknown;
  data?: unknown;
  failureCode?: string | null;
  failureKind?: string | null;
  upstreamCode?: string | null;
}

interface ImageCredentialRetryOptions {
  provider: string;
  requestedModel: string | null;
  credentials: any;
  execute: (credentials: any) => Promise<ImageGenerationResult>;
  requestedCount?: number;
  signal?: AbortSignal;
}

interface ImageCredentialRetryResult {
  credentials: any;
  result: ImageGenerationResult;
}

function connectionIdOf(credentials: any): string | null {
  const connectionId = credentials?.connectionId;
  return typeof connectionId === "string" && connectionId.trim().length > 0
    ? connectionId.trim()
    : null;
}

function isCredentialSentinel(credentials: any): boolean {
  return Boolean(credentials?.allRateLimited || credentials?.allExpired);
}

async function selectNextCredentials(
  provider: string,
  requestedModel: string | null,
  excludedConnectionIds: Set<string>,
  requiredWorkspacePlan?: string
) {
  return getProviderCredentialsWithQuotaPreflight(provider, null, null, requestedModel, {
    excludeConnectionIds: Array.from(excludedConnectionIds),
    requiredWorkspacePlan,
    preferredWorkspacePlan: requiredWorkspacePlan ? null : provider === "codex" ? "plus" : null,
    skipModelDiagnostics: true,
  });
}

function shouldRetryK12ImageOnPlus(
  provider: string,
  credentials: any,
  result: ImageGenerationResult,
  requestedCount: number,
  signal?: AbortSignal
): boolean {
  if (provider !== "codex" || requestedCount !== 1 || signal?.aborted || result.success)
    return false;
  const workspacePlan = credentials?.providerSpecificData?.workspacePlanType;
  if (typeof workspacePlan !== "string" || workspacePlan.toLowerCase() !== "k12") return false;
  if (!connectionIdOf(credentials)) return false;
  if (result.failureCode === "codex_image_no_result") {
    return (
      result.failureKind === "response_failed" &&
      ["overloaded", "server_error", "internal_error", "rate_limit_exceeded"].includes(
        result.upstreamCode || ""
      )
    );
  }
  if (
    typeof result.error === "string" &&
    /moderation|content[_ -]?policy|safety/i.test(result.error)
  ) {
    return false;
  }
  return [500, 502, 503, 504].includes(Number(result.status));
}

async function retryK12ImageOnPlus(
  provider: string,
  requestedModel: string | null,
  credentials: any,
  result: ImageGenerationResult,
  excludedConnectionIds: Set<string>,
  execute: (credentials: any) => Promise<ImageGenerationResult>,
  signal?: AbortSignal
): Promise<ImageCredentialRetryResult> {
  const plus = await selectNextCredentials(provider, requestedModel, excludedConnectionIds, "plus");
  if (!plus || isCredentialSentinel(plus) || !connectionIdOf(plus) || signal?.aborted) {
    return { credentials, result };
  }
  try {
    const refreshed = await checkAndRefreshToken(provider, plus);
    if (signal?.aborted) return { credentials, result };
    log.info("IMAGE", "Retrying transient Codex image failure on a plus account", {
      failedConnectionId: connectionIdOf(credentials),
      retryConnectionId: connectionIdOf(refreshed),
      failureCode: result.failureCode,
      failureKind: result.failureKind,
      upstreamCode: result.upstreamCode,
    });
    const retryResult = await execute(refreshed);
    log.info("IMAGE", "Codex image plus-account retry finished", {
      failedConnectionId: connectionIdOf(credentials),
      retryConnectionId: connectionIdOf(refreshed),
      recovered: retryResult.success,
      status: retryResult.status ?? 200,
    });
    return { credentials: refreshed, result: retryResult };
  } catch (error) {
    log.warn("IMAGE", "Codex image plus-account retry unavailable", {
      connectionId: connectionIdOf(plus),
      error: sanitizeErrorMessage(error instanceof Error ? error : new Error(String(error))),
    });
    return { credentials, result };
  }
}

/**
 * Keep image requests on the same credential lifecycle as chat requests.
 *
 * Each connection is attempted at most once. A refresh failure or upstream 401
 * excludes only that connection for the current request; it does not mutate the
 * account into a terminal state because another request may refresh it normally.
 */
export async function executeImageWithCredentialFallback({
  provider,
  requestedModel,
  credentials,
  execute,
  requestedCount = 1,
  signal,
}: ImageCredentialRetryOptions): Promise<ImageCredentialRetryResult> {
  // Local/no-auth image providers intentionally have no credential row. They
  // still need one direct attempt, but there is no account identity to refresh
  // or rotate after a 401.
  if (!credentials) {
    return { credentials, result: await execute(credentials) };
  }

  const excludedConnectionIds = new Set<string>();
  let currentCredentials = credentials;
  let lastCredentials = credentials;
  let lastResult: ImageGenerationResult | null = null;

  while (currentCredentials && !isCredentialSentinel(currentCredentials)) {
    const connectionId = connectionIdOf(currentCredentials);
    if (connectionId && excludedConnectionIds.has(connectionId)) break;
    if (connectionId) excludedConnectionIds.add(connectionId);

    try {
      currentCredentials = await checkAndRefreshToken(provider, currentCredentials);
    } catch (error) {
      log.warn("IMAGE", "Credential refresh failed; trying another image-provider account", {
        provider,
        connectionId,
        error: sanitizeErrorMessage(error instanceof Error ? error : new Error(String(error))),
      });
      if (!connectionId) throw error;
      currentCredentials = await selectNextCredentials(
        provider,
        requestedModel,
        excludedConnectionIds
      );
      continue;
    }

    lastCredentials = currentCredentials;
    lastResult = await execute(currentCredentials);
    if (
      shouldRetryK12ImageOnPlus(provider, currentCredentials, lastResult, requestedCount, signal)
    ) {
      return retryK12ImageOnPlus(
        provider,
        requestedModel,
        currentCredentials,
        lastResult,
        excludedConnectionIds,
        execute,
        signal
      );
    }
    if (lastResult.success || Number(lastResult.status) !== 401 || !connectionId) {
      return { credentials: lastCredentials, result: lastResult };
    }

    log.warn("IMAGE", "Image provider rejected credentials; trying another account", {
      provider,
      connectionId,
    });
    currentCredentials = await selectNextCredentials(
      provider,
      requestedModel,
      excludedConnectionIds
    );
  }

  return {
    credentials: lastCredentials,
    result: lastResult || {
      success: false,
      status: 401,
      error: "Authentication failed for all eligible image-provider accounts",
    },
  };
}
