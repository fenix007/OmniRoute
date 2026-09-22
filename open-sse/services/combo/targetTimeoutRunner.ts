import { errorResponse } from "../../utils/error.ts";
import { COMBO_PER_MODEL_TIMEOUT_REASON } from "./comboAbortReasons.ts";
import type { HandleSingleModel, SingleModelTarget, ComboLogger } from "./types.ts";

type TimeoutRunnerDeps = {
  handleSingleModel: HandleSingleModel;
  comboTargetTimeoutMs: number;
  retryCodexAccountOnTimeout?: boolean;
  signal?: AbortSignal | null;
  log: ComboLogger;
};

/** A fresh deadline per dispatch; only a local timeout permits account rotation. */
async function runAttempt(
  deps: TimeoutRunnerDeps,
  body: Record<string, unknown>,
  modelStr: string,
  target: SingleModelTarget | undefined,
  parentSignal: AbortSignal | null
): Promise<{ response: Response; timedOut: boolean }> {
  const timeoutController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<Response>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      deps.log.warn("COMBO", `Model ${modelStr} exceeded ${deps.comboTargetTimeoutMs}ms timeout`);
      timeoutController.abort(new Error(COMBO_PER_MODEL_TIMEOUT_REASON));
      resolve(
        new Response(JSON.stringify({ error: { message: `Model ${modelStr} timed out` } }), {
          status: 524,
          headers: { "Content-Type": "application/json" },
        })
      );
    }, deps.comboTargetTimeoutMs);
  });
  const onParentAbort = () => timeoutController.abort(parentSignal?.reason);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    const response = await Promise.race([
      deps
        .handleSingleModel(body, modelStr, {
          ...target,
          modelAbortSignal: timeoutController.signal,
        })
        .then((result) => {
          // A late response has lost the race and must never reach the caller.
          if (timedOut) void result.body?.cancel().catch(() => {});
          return result;
        })
        .catch((err) =>
          timedOut
            ? new Response(null, { status: 599 })
            : errorResponse(502, err?.message ?? "Upstream model error")
        ),
      timeoutPromise,
    ]);
    return { response, timedOut };
  } finally {
    clearTimeout(timeoutId);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

/** Retry one different Codex account before returning a timeout to combo fallback. */
export function buildTargetTimeoutRunner(deps: TimeoutRunnerDeps): HandleSingleModel {
  // Shared across this request's combo/set retries, never across client requests.
  const retriedTargets = new Set<string>();
  return async (body, modelStr, target) => {
    if (deps.comboTargetTimeoutMs <= 0) {
      return deps
        .handleSingleModel(body, modelStr, target)
        .catch((err) => errorResponse(502, err?.message ?? "Upstream model error"));
    }
    const signals = [deps.signal, target?.modelAbortSignal].filter(
      (signal): signal is AbortSignal => !!signal
    );
    const parentSignal = signals.length ? AbortSignal.any(signals) : null;
    const resolvedTarget = target && "provider" in target ? target : null;
    const provider =
      resolvedTarget?.providerId || resolvedTarget?.provider || modelStr.split("/")[0];
    const retryKey = resolvedTarget?.executionKey || modelStr;
    const canRetry =
      deps.retryCodexAccountOnTimeout === true &&
      (provider === "codex" || provider === "cx") &&
      !resolvedTarget?.connectionId &&
      !retriedTargets.has(retryKey);
    const retryBody = canRetry ? structuredClone(body) : null;
    const selectedConnections = new Set<string>();
    const observedTarget = {
      ...target,
      onConnectionSelected: (id: string) => {
        selectedConnections.add(id);
        target?.onConnectionSelected?.(id);
      },
      modelAbortSignal: parentSignal,
    } as SingleModelTarget;
    const first = await runAttempt(deps, body, modelStr, observedTarget, parentSignal);
    if (!canRetry || !first.timedOut || !selectedConnections.size || parentSignal?.aborted) {
      return first.response;
    }
    retriedTargets.add(retryKey);
    deps.log.info(
      "COMBO",
      `Retrying ${modelStr} on another Codex account before provider fallback`
    );
    const excludeConnectionIds = Array.from(
      new Set([...(target?.excludeConnectionIds ?? []), ...selectedConnections])
    );
    const retryConnections = new Set<string>();
    const retry = await runAttempt(
      deps,
      retryBody!,
      modelStr,
      {
        ...observedTarget,
        excludeConnectionIds,
        onConnectionSelected: (id) => {
          retryConnections.add(id);
          target?.onConnectionSelected?.(id);
        },
      },
      parentSignal
    );
    // No eligible sibling should preserve the original timeout classification.
    if (!retryConnections.size && !retry.response.ok) {
      void retry.response.body?.cancel().catch(() => {});
      return first.response;
    }
    void first.response.body?.cancel().catch(() => {});
    return retry.response;
  };
}
