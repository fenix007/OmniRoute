import { isLocalStreamLifecycleError } from "../../shared/utils/circuitBreaker";

export const PROVIDER_BREAKER_FAILURE_STATUSES = new Set([408, 500, 502, 503, 504]);

export function classifyLocalAbortFailure(
  error: unknown,
  requestSignalAborted = false
): { status: 499; message: "Request aborted" } | null {
  const message =
    typeof error === "string"
      ? error
      : error &&
          typeof error === "object" &&
          typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "";
  const isSignalAbortReason =
    requestSignalAborted &&
    /request_signal_aborted|client disconnected|operation was aborted/i.test(message);
  return isLocalStreamLifecycleError(error) || isSignalAbortReason
    ? { status: 499, message: "Request aborted" }
    : null;
}

/**
 * Decide whether a terminal single-model result should affect the provider-wide
 * circuit breaker. Client aborts, local queue capacity and network-path errors
 * are local failures even when their fallback status is a breaker-worthy 5xx.
 */
export function shouldTripProviderBreakerForResult(
  result: {
    status: number;
    errorCode?: string | null;
    errorType?: string | null;
    error?: unknown;
  },
  isCombo: boolean,
  forceLiveComboTest: boolean
): boolean {
  return (
    !forceLiveComboTest &&
    !isCombo &&
    result.errorCode !== "proxy_unreachable" &&
    result.errorCode !== "RATE_LIMIT_QUEUE_TIMEOUT" &&
    result.errorCode !== "RATE_LIMIT_QUEUE_WEDGED" &&
    PROVIDER_BREAKER_FAILURE_STATUSES.has(Number(result.status))
  );
}
