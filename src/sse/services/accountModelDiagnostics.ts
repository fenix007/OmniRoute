import { getCodexDefaultHeaders } from "@omniroute/open-sse/config/codexClient.ts";
import { resolveCodexAccountId } from "@omniroute/open-sse/utils/codexAccount.ts";
import {
  isAccountScopedModelUnsupported400,
  isAccountScopedModelUnavailable404,
} from "@omniroute/open-sse/services/accountModelErrors.ts";
import {
  accountModelCredentialIdentity,
  getAccountModelSupport,
  normalizeAccountModel,
  saveAccountModelSupport,
  type AccountModelSupport,
  type ModelSupportConnection,
} from "@/lib/db/accountModelSupport";
import { resolveProxyForConnection } from "@/lib/db/settings";
import { safeOutboundFetch } from "@/shared/network/safeOutboundFetch";

const pending = new Map<string, Promise<AccountModelSupport>>();
let activeProbes = 0;
const MAX_ACTIVE_PROBES = 4;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export function classifyModelSupportError(status: number, message: string) {
  if (
    isAccountScopedModelUnsupported400(status, message) ||
    isAccountScopedModelUnavailable404(status, message)
  ) {
    return {
      status: "unsupported" as const,
      reason: "account_model_unsupported",
      httpStatus: status,
    };
  }
  return {
    status: "unknown" as const,
    reason:
      status === 401 || status === 403
        ? "authentication_failed"
        : status === 429 || status === 402
          ? "quota_or_rate_limit"
          : "upstream_error",
    httpStatus: status,
  };
}

function errorMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const error = (body as { error?: unknown }).error;
  return typeof error === "string"
    ? error
    : error &&
        typeof error === "object" &&
        typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "";
}

async function readProbeResult(
  response: Response
): Promise<Pick<AccountModelSupport, "status" | "reason" | "httpStatus">> {
  if (!response.body) return classifyModelSupportError(response.status, "");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES)
        return { status: "unknown", reason: "response_too_large", httpStatus: response.status };
      text += decoder.decode(chunk.value, { stream: true });
      if (response.ok) {
        const lines = text.split("\n");
        text = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          let event: {
            type?: string;
            error?: unknown;
            response?: { error?: unknown; status?: string };
          };
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (!event || typeof event !== "object") continue;
          if (event.type === "response.failed" || event.type === "error") {
            const message = errorMessage(event.response || event);
            const status = /does not exist or you do not have access/i.test(message) ? 404 : 400;
            return classifyModelSupportError(status, message);
          }
          if (
            event.type === "response.completed" &&
            !event.response?.error &&
            event.response?.status !== "failed"
          ) {
            return { status: "supported", reason: "probe_completed", httpStatus: response.status };
          }
        }
      }
    }
    if (!response.ok) {
      let message = "";
      try {
        message = errorMessage(JSON.parse(text));
      } catch {
        /* No trusted model error. */
      }
      return classifyModelSupportError(response.status, message);
    }
    return { status: "unknown", reason: "no_terminal_evidence", httpStatus: response.status };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** A minimal synthetic request; never sends the caller's prompt, tools or client headers. */
export async function diagnoseAccountModel(
  provider: string,
  connection: ModelSupportConnection,
  model: string,
  options: { refresh?: boolean; signal?: AbortSignal } = {}
): Promise<AccountModelSupport | null> {
  if (provider !== "codex" && provider !== "cx") return null;
  const cached = getAccountModelSupport(provider, connection, model);
  if (cached && !options.refresh) return cached;
  const wireModel = normalizeAccountModel(provider, model);
  const id = connection.connectionId || connection.id;
  if (!id) return null;
  const key = JSON.stringify([id, wireModel, accountModelCredentialIdentity(connection)]);
  if (pending.has(key)) return pending.get(key)!;
  if (activeProbes >= MAX_ACTIVE_PROBES || !connection.accessToken) return null;
  const run = (async () => {
    activeProbes++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    let result: Pick<AccountModelSupport, "status" | "reason" | "httpStatus">;
    try {
      const workspace = resolveCodexAccountId(
        connection.accessToken,
        connection.providerSpecificData
      );
      const response = await safeOutboundFetch("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
        retry: false,
        allowRedirect: false,
        guard: "public-only",
        timeoutMs: PROBE_TIMEOUT_MS,
        signal,
        proxyConfig: await resolveProxyForConnection(id),
        headers: {
          ...getCodexDefaultHeaders(),
          Authorization: `Bearer ${connection.accessToken}`,
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          originator: "codex_cli_rs",
          ...(workspace ? { "chatgpt-account-id": workspace } : {}),
        },
        body: JSON.stringify({
          model: wireModel,
          input: [{ role: "user", content: [{ type: "input_text", text: "Reply OK." }] }],
          instructions: "Reply with OK only.",
          reasoning: { effort: "low" },
          stream: true,
          store: false,
        }),
      });
      result = await readProbeResult(response);
    } catch {
      result = {
        status: "unknown",
        reason: signal.aborted ? "probe_timeout_or_cancelled" : "probe_unavailable",
        httpStatus: null,
      };
    } finally {
      clearTimeout(timer);
      activeProbes--;
    }
    return saveAccountModelSupport(provider, connection, wireModel, result);
  })();
  pending.set(key, run);
  try {
    return await run;
  } finally {
    pending.delete(key);
  }
}
