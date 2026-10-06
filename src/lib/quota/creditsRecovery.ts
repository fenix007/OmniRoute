/** Recheck exhausted compatible API-key accounts using bounded real inference.
 * A model-list/auth check cannot prove restored credit. Failed probes never change
 * routing state, credentials, or error classifications. No upstream text is logged.
 */
import { getComboModelString } from "../combos/steps";

export interface CreditsRecoveryConnection {
  id: string;
  provider: string;
  isActive?: boolean | number;
  authType?: string;
  testStatus?: string;
  apiKey?: string;
  updatedAt?: string;
  lastErrorAt?: string;
  rateLimitedUntil?: string;
  healthCheckInterval?: number;
  providerSpecificData?: Record<string, unknown>;
}
export const CREDITS_RECOVERY_INTERVAL_MS = 15 * 60_000;
const MAX_PROBES_PER_TICK = 4;
const PROBE_TIMEOUT_MS = 15_000;

export function isCreditsRecoveryCandidate(conn: CreditsRecoveryConnection): boolean {
  return !!(
    conn.id &&
    (conn.isActive === true || conn.isActive === 1) &&
    conn.authType === "apikey" &&
    conn.testStatus === "credits_exhausted" &&
    conn.provider?.startsWith("openai-compatible-") &&
    conn.apiKey?.trim() &&
    conn.healthCheckInterval !== 0
  );
}

/** Prefer an explicitly configured probe model; otherwise use a saved combo target.
 * Never invent a provider model or send a client prompt in a background probe. */
export function selectCreditsRecoveryModel(
  conn: CreditsRecoveryConnection,
  combos: Array<{ models?: unknown[] }>,
  prefix?: string
): string | null {
  const configured = conn.providerSpecificData?.validationModelId;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  let fallbackModel: string | null = null;
  for (const combo of combos) {
    for (const step of combo.models || []) {
      if (step && typeof step === "object") {
        const target = step as Record<string, unknown>;
        if (target.connectionId && target.connectionId !== conn.id) continue;
        if (
          Array.isArray(target.allowedConnectionIds) &&
          target.allowedConnectionIds.length &&
          !target.allowedConnectionIds.includes(conn.id)
        )
          continue;
      }
      const full = getComboModelString(step);
      const slash = full?.indexOf("/") ?? -1;
      if (!full || slash < 1) continue;
      const provider = full.slice(0, slash);
      if (provider === conn.provider || (prefix && provider === prefix)) {
        fallbackModel = full.slice(slash + 1);
      }
    }
  }
  return fallbackModel;
}

/** Non-empty successful inference is positive evidence, unlike 200 /models,
 * 400/429 auth validation, HTML error pages, or an empty completion. */
export function hasCreditInferenceEvidence(status: number, body: unknown): boolean {
  if (status < 200 || status >= 300 || !body || typeof body !== "object") return false;
  const data = body as Record<string, unknown>;
  if (data.error) return false;
  if (data.object === "chat.completion" && Array.isArray(data.choices)) {
    return data.choices.some((choice) => {
      const text = choice?.message?.content;
      return typeof text === "string" && text.trim().length > 0;
    });
  }
  if (
    data.object === "response" &&
    (data.status === "completed" || data.status === "incomplete") &&
    Array.isArray(data.output)
  ) {
    return data.output.some(
      (item) =>
        item?.type === "message" &&
        Array.isArray(item.content) &&
        item.content.some(
          (part) =>
            part?.type === "output_text" &&
            typeof part.text === "string" &&
            part.text.trim().length > 0
        )
    );
  }
  return false;
}

const MAX_PROBE_RESPONSE_BYTES = 64 * 1024;

/** Keep an untrusted upstream response within the probe's memory/time budget. */
export async function readCreditsProbePayload(
  response: Response,
  signal: AbortSignal
): Promise<unknown> {
  if (!response.body) return null;
  signal.throwIfAborted();
  const reader = response.body.getReader();
  let onAbort: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Credit probe deadline exceeded"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  let complete = false;
  try {
    const declaredLength = Number(response.headers.get("content-length"));
    if (declaredLength > MAX_PROBE_RESPONSE_BYTES) return null;
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) {
        complete = true;
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_PROBE_RESPONSE_BYTES) return null;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function probeCreditsRecovery(
  conn: CreditsRecoveryConnection,
  model: string,
  fetchProbe?: (url: string, options: Record<string, unknown>) => Promise<Response>
): Promise<boolean> {
  const data = conn.providerSpecificData || {};
  const baseUrl = typeof data.baseUrl === "string" ? data.baseUrl.trim().replace(/\/$/, "") : "";
  if (!baseUrl || !model || !conn.apiKey) return false;
  const responses =
    data.apiType === "responses" || conn.provider.startsWith("openai-compatible-responses-");
  const path =
    typeof data.chatPath === "string" && data.chatPath.startsWith("/")
      ? data.chatPath
      : responses
        ? "/responses"
        : "/chat/completions";
  const [{ safeOutboundFetch }, { getProviderValidationGuard }, { buildBearerHeaders }] =
    await Promise.all([
      import("@/shared/network/safeOutboundFetch"),
      import("@/shared/network/outboundUrlGuard"),
      import("@/lib/providers/validation/headers"),
    ]);
  try {
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const response = await (fetchProbe || safeOutboundFetch)(`${baseUrl}${path}`, {
      method: "POST",
      headers: buildBearerHeaders(conn.apiKey, data),
      body: JSON.stringify(
        responses
          ? {
              model,
              input: "Reply OK.",
              max_output_tokens: 64,
              stream: false,
              store: false,
            }
          : {
              model,
              messages: [{ role: "user", content: "Reply OK." }],
              max_tokens: 64,
              stream: false,
            }
      ),
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
      allowRedirect: false,
      retry: false,
      guard: getProviderValidationGuard(),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return false;
    }
    return hasCreditInferenceEvidence(
      response.status,
      await readCreditsProbePayload(response, signal)
    );
  } catch {
    return false;
  }
}

interface CreditsRecoveryDeps {
  nowMs?: number;
  attempts?: Map<string, number>;
  loadConnections?: () => Promise<CreditsRecoveryConnection[]>;
  loadCombos?: () => Promise<Array<{ models?: unknown[] }>>;
  loadPrefix?: (provider: string) => Promise<string | undefined>;
  probe?: (conn: CreditsRecoveryConnection, model: string) => Promise<boolean>;
  recover?: (conn: CreditsRecoveryConnection) => Promise<boolean>;
}
const lastAttempts = new Map<string, number>();

/** Public bounded pass, also usable after a top-up. The same cooldown applies. */
export async function runCreditsRecoveryTick(deps: CreditsRecoveryDeps = {}) {
  const result = { scanned: 0, probed: 0, recovered: 0 };
  const now = deps.nowMs ?? Date.now();
  const attempts = deps.attempts || lastAttempts;
  const load =
    deps.loadConnections ||
    (async () => {
      const { getProviderConnections } = await import("@/lib/db/providers");
      return (await getProviderConnections({
        isActive: true,
      })) as unknown as CreditsRecoveryConnection[];
    });
  const connections = await load();
  result.scanned = connections.length;
  const ids = new Set(connections.map((conn) => conn.id));
  for (const id of attempts.keys()) if (!ids.has(id)) attempts.delete(id);
  const candidates = connections.filter(
    (conn) =>
      isCreditsRecoveryCandidate(conn) &&
      (!attempts.has(conn.id) || now - attempts.get(conn.id)! >= CREDITS_RECOVERY_INTERVAL_MS)
  );
  // Oldest attempts first: a large pool cannot starve behind repeated failures.
  candidates.sort((a, b) => (attempts.get(a.id) ?? 0) - (attempts.get(b.id) ?? 0));
  if (!candidates.length) return result;
  const combos = await (
    deps.loadCombos ||
    (async () => {
      const { getCombos } = await import("@/lib/db/combos");
      return (await getCombos()) as Array<{ models?: unknown[] }>;
    })
  )();
  for (const conn of candidates.slice(0, MAX_PROBES_PER_TICK)) {
    // A second manual/scheduled pass may have selected the same stale snapshot.
    if (attempts.has(conn.id) && now - attempts.get(conn.id)! < CREDITS_RECOVERY_INTERVAL_MS)
      continue;
    attempts.set(conn.id, now);
    try {
      const prefix = await (
        deps.loadPrefix ||
        (async (provider) => {
          const { getProviderNodeById } = await import("@/lib/db/providers/nodes");
          const node = await getProviderNodeById(provider);
          return typeof node?.prefix === "string" ? node.prefix : undefined;
        })
      )(conn.provider);
      const model = selectCreditsRecoveryModel(conn, combos, prefix);
      if (!model) continue;
      result.probed++;
      const probe =
        deps.probe ||
        (async (current, selectedModel) => {
          const { resolveProxyForConnection } = await import("@/lib/db/settings");
          const { runWithProxyContext } = await import("@omniroute/open-sse/utils/proxyFetch.ts");
          const resolved = await resolveProxyForConnection(current.id);
          return runWithProxyContext(resolved?.proxy || null, () =>
            probeCreditsRecovery(current, selectedModel)
          );
        });
      if (!(await probe(conn, model))) continue;
      const recover =
        deps.recover ||
        (async (current) => {
          const { clearConnectionErrorIfUnchanged } = await import("@/lib/db/providers");
          // Without a persisted row version we cannot prove credentials/settings
          // have not changed during the network request. Leave such rows alone.
          if (!current.updatedAt) return false;
          const applied = await clearConnectionErrorIfUnchanged(current.id, {
            testStatus: current.testStatus,
            lastErrorAt: current.lastErrorAt,
            rateLimitedUntil: current.rateLimitedUntil,
            isActive: true,
            updatedAt: current.updatedAt,
            clearPrimaryKeyHealth: true,
          });
          if (applied) {
            const { recordKeySuccess } =
              await import("@omniroute/open-sse/services/apiKeyRotator.ts");
            recordKeySuccess(current.id, "primary");
          }
          return applied;
        });
      if (await recover(conn)) result.recovered++;
    } catch {
      // Isolate failures; never log response bodies, URLs, credentials, or errors.
    }
  }
  return result;
}

declare global {
  var __omnirouteCreditsRecovery:
    | {
        timer: ReturnType<typeof setInterval> | null;
        running: boolean;
      }
    | undefined;
}

export function initCreditsRecoveryScheduler(): void {
  if (
    process.env.NEXT_PHASE === "phase-production-build" ||
    process.env.NODE_ENV === "test" ||
    process.env.VITEST !== undefined ||
    process.argv.some((arg) => arg.includes("test")) ||
    ["OMNIROUTE_DISABLE_BACKGROUND_SERVICES", "OMNIROUTE_DISABLE_CREDITS_RECOVERY"].some((key) =>
      /^(1|true|yes|on)$/i.test(process.env[key] || "")
    )
  )
    return;
  const state = (globalThis.__omnirouteCreditsRecovery ||= { timer: null, running: false });
  if (state.timer) return;
  state.timer = setInterval(async () => {
    if (state.running) return;
    state.running = true;
    try {
      const result = await runCreditsRecoveryTick();
      if (result.probed)
        console.log(`[CreditsRecovery] probed=${result.probed} recovered=${result.recovered}`);
    } catch {
      console.warn("[CreditsRecovery] recovery pass failed");
    } finally {
      state.running = false;
    }
  }, 60_000);
  state.timer.unref?.();
}

export function stopCreditsRecoveryScheduler(): void {
  const state = globalThis.__omnirouteCreditsRecovery;
  if (state?.timer) clearInterval(state.timer);
  if (state) state.timer = null;
}
