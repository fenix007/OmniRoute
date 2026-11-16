import { isNetworkFailureMessage } from "./recoveryPolicy";
import { withStatus } from "./refreshState";
import type { JsonRecord, ProviderConnectionLike } from "./types";

type ProxyRequestError = { message?: string; code?: string; cause?: { code?: string } };

function isThrownNetworkError(value: unknown): boolean {
  const error = value as ProxyRequestError | null;
  return (
    error?.message === "fetch failed" ||
    error?.code === "PROXY_UNREACHABLE" ||
    error?.code === "UND_ERR_CONNECT_TIMEOUT" ||
    error?.cause?.code === "ECONNREFUSED"
  );
}

export async function fetchQuotaWithProxyRetry(
  connection: ProviderConnectionLike,
  proxyInfo: { proxy?: unknown } | null | undefined,
  failClosedOnProxyFailure: boolean,
  fetchUsageWithContext: (proxy: unknown) => Promise<{ usage: JsonRecord }>
) {
  const connectionId = connection.id;
  let result: { usage: JsonRecord };
  const proxyConfig = proxyInfo?.proxy || null;

  try {
    result = await fetchUsageWithContext(proxyConfig);
  } catch (error) {
    if (proxyConfig && isThrownNetworkError(error)) {
      if (failClosedOnProxyFailure) {
        console.warn(
          "[ProviderLimits] Account-scoped %s proxy fetch failed for %s; failing closed without direct retry:",
          connection.provider,
          connectionId,
          (error as ProxyRequestError)?.message
        );
        throw error;
      }

      console.warn(
        "[ProviderLimits] Proxy fetch threw for %s, retrying without proxy:",
        connectionId,
        (error as ProxyRequestError)?.message
      );
      result = await fetchUsageWithContext(null);
    } else {
      throw error;
    }
  }

  if (proxyConfig && isNetworkFailureMessage(result.usage?.message)) {
    if (failClosedOnProxyFailure) {
      const message =
        typeof result.usage.message === "string"
          ? result.usage.message
          : "Provider-limits proxy request failed";
      console.warn(
        "[ProviderLimits] Account-scoped %s proxy usage failed for %s; failing closed without direct retry:",
        connection.provider,
        connectionId,
        message
      );
      throw withStatus(new Error(message), 503);
    }

    console.warn(
      "[ProviderLimits] Proxy usage returned network error for %s, retrying without proxy:",
      connectionId,
      result.usage.message
    );
    result = await fetchUsageWithContext(null);
  }

  return result;
}
