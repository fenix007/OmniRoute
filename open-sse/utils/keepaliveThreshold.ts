/**
 * Adaptive keepalive threshold resolver for streaming routes.
 *
 * Web-session and anonymous-fallback providers are slower to produce the first
 * byte because they route through browser sessions or public rate-limited
 * endpoints. The default 2 s keepalive threshold is too aggressive for these
 * providers — the keepalive stream commits before the upstream has a chance to
 * respond, adding unnecessary SSE framing overhead.
 *
 * `resolveKeepaliveThreshold(model)` inspects the model prefix and returns a
 * longer threshold (15 s) for known-slow providers, or the default (2 s) for
 * everything else.
 */

import { NOAUTH_PROVIDERS } from "@/shared/constants/providers";
import { APIKEY_PROVIDERS } from "@/shared/constants/providers";
import { WEB_COOKIE_PROVIDERS } from "@/shared/constants/providers";
import { WEB_SESSION_CREDENTIAL_REQUIREMENTS } from "@/shared/providers/webSessionCredentials";

// The only hard ceiling here is the strictest client idle-read timeout we must beat
// (Codex CLI's reqwest, ~5 s). Everything below that is a tradeoff, and it is not a
// latency tradeoff — it decides whether an upstream failure reaches the client as a
// real HTTP status or as an in-band `event: error` inside an already-committed 200.
// A handler that fails after the threshold can no longer set a status, so client
// retry logic keyed on 429/5xx never fires. 4 s keeps a 1 s safety margin under the
// reqwest timeout while giving the handler (routing + combo failover + upstream call)
// twice as long to produce a real status.
const DEFAULT_THRESHOLD_MS = 4_000;
const SLOW_THRESHOLD_MS = 15_000;
const THRESHOLD_ENV_VAR = "OMNIROUTE_KEEPALIVE_THRESHOLD_MS";

/**
 * Reads the default threshold from {@link THRESHOLD_ENV_VAR} so a deployment can
 * retune (or revert to the historical 2000) without a rebuild. Invalid or
 * out-of-range values fall back to {@link DEFAULT_THRESHOLD_MS}; the upper bound
 * stays under the reqwest idle-read timeout the keepalive exists to beat.
 */
function resolveDefaultThresholdMs(): number {
  const raw = process.env[THRESHOLD_ENV_VAR];
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_THRESHOLD_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_THRESHOLD_MS;

  const rounded = Math.trunc(parsed);
  if (rounded < 0 || rounded > 4_500) return DEFAULT_THRESHOLD_MS;

  return rounded;
}

const SLOW_PROVIDER_IDS: Set<string> = new Set();

function addSlowProvider(id: string, alias?: string) {
  SLOW_PROVIDER_IDS.add(id);
  if (typeof alias === "string" && alias) SLOW_PROVIDER_IDS.add(alias);
}

for (const [id, def] of Object.entries(NOAUTH_PROVIDERS)) {
  if ((def as Record<string, unknown>).noAuth === true) {
    addSlowProvider(id, (def as Record<string, unknown>).alias as string | undefined);
  }
}

for (const [id, def] of Object.entries(APIKEY_PROVIDERS)) {
  if ((def as Record<string, unknown>).anonymousFallback === true) {
    addSlowProvider(id, (def as Record<string, unknown>).alias as string | undefined);
  }
}

for (const [id, def] of Object.entries(WEB_COOKIE_PROVIDERS)) {
  addSlowProvider(id, (def as Record<string, unknown>).alias as string | undefined);
}

for (const id of Object.keys(WEB_SESSION_CREDENTIAL_REQUIREMENTS)) {
  SLOW_PROVIDER_IDS.add(id);
}

export const SLOW_KEEPALIVE_PROVIDERS: ReadonlySet<string> = SLOW_PROVIDER_IDS;

export function resolveKeepaliveThreshold(model: string | undefined | null): number {
  const defaultThresholdMs = resolveDefaultThresholdMs();
  if (!model || typeof model !== "string") return defaultThresholdMs;

  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0) return defaultThresholdMs;

  const prefix = model.slice(0, slashIndex);
  if (SLOW_PROVIDER_IDS.has(prefix)) return SLOW_THRESHOLD_MS;

  return defaultThresholdMs;
}
