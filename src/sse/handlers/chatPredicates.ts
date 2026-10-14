import { isLocalStreamLifecycleError } from "../../shared/utils/circuitBreaker";
import {
  COMBO_HEDGE_CANCELLED_REASON,
  COMBO_PER_MODEL_TIMEOUT_REASON,
} from "../../../open-sse/services/combo/comboAbortReasons";

export const PROVIDER_BREAKER_FAILURE_STATUSES = new Set([408, 500, 502, 503, 504]);

export function classifyLocalAbortFailure(
  error: unknown,
  requestSignalAborted = false,
  abortReason?: unknown
): { status: 499; message: string } | null {
  const message =
    typeof error === "string"
      ? error
      : error &&
          typeof error === "object" &&
          typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "";
  // Fetch may throw a generic AbortError; the local signal retains the actual
  // orchestration reason. Keep the 499 control flow while preserving diagnostics.
  const localReason = abortReason ?? error;
  const reasonMessage =
    typeof localReason === "string"
      ? localReason
      : localReason && typeof localReason === "object" && "message" in localReason
        ? String(localReason.message)
        : "";
  if (requestSignalAborted && reasonMessage === COMBO_PER_MODEL_TIMEOUT_REASON) {
    return { status: 499, message: "Model timeout: combo-per-model-timeout" };
  }
  if (requestSignalAborted && reasonMessage === COMBO_HEDGE_CANCELLED_REASON) {
    return { status: 499, message: "Request cancelled: hedge-cancelled" };
  }
  const isSignalAbortReason =
    requestSignalAborted &&
    (error === abortReason ||
      /request_signal_aborted|client disconnected|operation was aborted/i.test(message) ||
      message === COMBO_PER_MODEL_TIMEOUT_REASON ||
      message === COMBO_HEDGE_CANCELLED_REASON);
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
