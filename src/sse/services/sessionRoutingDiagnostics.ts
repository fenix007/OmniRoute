import {
  parseSessionRouting,
  type SessionRouting,
  type SessionSource,
} from "@/lib/usage/sessionRouting";

/** Snapshot selection metadata before asynchronous dispatch, never from client diagnostics. */
export function buildSessionRouting(options: {
  sessionKey?: string | null;
  sessionSource?: SessionSource;
  previousPin: { connectionId: string; expiresAt: string } | null;
  previousConnectionId?: string | null;
  selectedConnectionId: string;
  affinitySelected: boolean;
  forcedConnectionId?: string | null;
  now: number;
}): SessionRouting | null {
  const sessionHash = /^session:sha256:([a-f0-9]{64})$/.exec(options.sessionKey ?? "")?.[1] ?? null;
  const previousConnectionId =
    options.previousConnectionId ?? options.previousPin?.connectionId ?? null;
  let routingReason: SessionRouting["routingReason"] = options.forcedConnectionId
    ? "forced_connection"
    : sessionHash
      ? "strategy"
      : "no_session";
  if (options.affinitySelected) {
    routingReason =
      options.previousPin && Date.parse(options.previousPin.expiresAt) <= options.now
        ? "affinity_expired"
        : previousConnectionId && previousConnectionId !== options.selectedConnectionId
          ? "affinity_reassigned"
          : options.previousPin
            ? "affinity_reused"
            : "affinity_created";
  }
  return parseSessionRouting({
    sessionHash,
    sessionSource: options.sessionSource ?? "none",
    routingReason,
    previousConnectionId,
  });
}
