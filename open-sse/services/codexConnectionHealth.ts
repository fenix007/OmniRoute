/**
 * Short-term health of Codex connections, used to steer *new* sessions away
 * from accounts the backend is currently throttling.
 *
 * Production shows two clusters of equally-planned accounts: some answer with
 * "servers are currently overloaded" 502s and roughly double TTFT, others stay
 * fast. Quota-deadline routing alone keeps feeding the throttled ones. Pinned
 * sessions never consult this (moving them would throw away a warm prompt
 * cache, which costs far more than the TTFT gap), so it only shapes the choice
 * of a connection for a session that has none yet.
 *
 * State is in-memory and decays on its own: events older than WINDOW_MS are
 * dropped, so a demoted account returns to rotation without new traffic.
 */

const WINDOW_MS = 10 * 60_000;
/** Overload events lose half their weight every OVERLOAD_HALF_LIFE_MS. */
const OVERLOAD_HALF_LIFE_MS = 3 * 60_000;
/** TTFT samples needed on a connection before its latency is trusted. */
const MIN_TTFT_SAMPLES = 5;
/** A connection only counts as slow once its median TTFT exceeds the pool's by this much. */
const SLOW_RATIO = 1.3;
const MIN_FACTOR = 0.1;
const MAX_SAMPLES = 200;

const OVERLOAD_PATTERN =
  /overloaded|at capacity|server_is_overloaded|service_unavailable|temporarily unavailable/i;

interface ConnectionEvents {
  overloads: number[];
  ttft: Array<{ at: number; ms: number }>;
  /** Attempts with no useful output yet at the slow-start threshold (censored TTFT). */
  slowStarts: number[];
}

const events = new Map<string, ConnectionEvents>();

function entry(connectionId: string): ConnectionEvents {
  let current = events.get(connectionId);
  if (!current) {
    current = { overloads: [], ttft: [], slowStarts: [] };
    events.set(connectionId, current);
  }
  return current;
}

function prune(current: ConnectionEvents, nowMs: number): void {
  const cutoff = nowMs - WINDOW_MS;
  current.overloads = current.overloads.filter((at) => at > cutoff).slice(-MAX_SAMPLES);
  current.ttft = current.ttft.filter((sample) => sample.at > cutoff).slice(-MAX_SAMPLES);
  current.slowStarts = current.slowStarts.filter((at) => at > cutoff).slice(-MAX_SAMPLES);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function isCodexOverloadFailure(status: number, errorText: unknown): boolean {
  return (
    (status === 502 || status === 503 || status === 529) &&
    typeof errorText === "string" &&
    OVERLOAD_PATTERN.test(errorText)
  );
}

export function recordCodexOverload(connectionId: string, nowMs = Date.now()): void {
  if (!connectionId) return;
  const current = entry(connectionId);
  current.overloads.push(nowMs);
  prune(current, nowMs);
}

export function recordCodexTtft(connectionId: string, ttftMs: number, nowMs = Date.now()): void {
  if (!connectionId || !Number.isFinite(ttftMs) || ttftMs <= 0) return;
  const current = entry(connectionId);
  current.ttft.push({ at: nowMs, ms: ttftMs });
  prune(current, nowMs);
}

/**
 * Multiplier in [MIN_FACTOR, 1] for a connection's routing weight.
 * `poolIds` are the candidates being compared; slowness is judged relative to
 * them so a globally slow backend does not demote everyone.
 */
export function codexConnectionHealthFactor(
  connectionId: string,
  poolIds: readonly string[],
  nowMs = Date.now()
): number {
  const current = events.get(connectionId);
  if (!current) return 1;
  prune(current, nowMs);

  const overloadPressure = current.overloads.reduce(
    (total, at) => total + 0.5 ** ((nowMs - at) / OVERLOAD_HALF_LIFE_MS),
    0
  );
  let factor = 1 / (1 + overloadPressure);

  if (current.ttft.length >= MIN_TTFT_SAMPLES) {
    const own = median(current.ttft.map((sample) => sample.ms));
    const peers = poolIds
      .filter((id) => id !== connectionId)
      .map((id) => {
        const peer = events.get(id);
        if (!peer) return null;
        prune(peer, nowMs);
        return peer.ttft.length >= MIN_TTFT_SAMPLES ? median(peer.ttft.map((s) => s.ms)) : null;
      })
      .filter((value): value is number => value !== null);
    const poolMedian = median(peers);
    if (own !== null && poolMedian !== null && own > poolMedian * SLOW_RATIO) {
      factor *= poolMedian / own;
    }
  }

  return Math.max(MIN_FACTOR, Math.min(1, factor));
}

/** Test hook. */
/**
 * An attempt crossed the slow-start threshold without useful output. This is a
 * censored observation ("TTFT > T"), so it is kept apart from TTFT samples and
 * does not affect the health factor yet; it only feeds telemetry.
 */
export function recordCodexSlowStart(connectionId: string, nowMs = Date.now()): void {
  if (!connectionId) return;
  const current = entry(connectionId);
  current.slowStarts.push(nowMs);
  prune(current, nowMs);
}

/** Slow starts of a connection within the health window. */
export function codexSlowStartCount(connectionId: string, nowMs = Date.now()): number {
  const current = events.get(connectionId);
  if (!current) return 0;
  prune(current, nowMs);
  return current.slowStarts.length;
}

export function resetCodexConnectionHealth(): void {
  events.clear();
}
