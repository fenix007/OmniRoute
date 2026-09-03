import { randomUUID } from "node:crypto";

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 128;
const STORE_KEY = "__omnirouteTraeCallbackStates";

type TraeCallbackStateStore = Map<string, number>;

function store(): TraeCallbackStateStore {
  const globals = globalThis as unknown as {
    [STORE_KEY]?: TraeCallbackStateStore;
  };
  if (!globals[STORE_KEY]) globals[STORE_KEY] = new Map<string, number>();
  return globals[STORE_KEY]!;
}

function prune(now = Date.now()): void {
  const states = store();
  for (const [state, expiresAt] of states) {
    if (expiresAt <= now) states.delete(state);
  }
  while (states.size >= MAX_PENDING_STATES) {
    const oldest = states.keys().next().value;
    if (typeof oldest !== "string") break;
    states.delete(oldest);
  }
}

export function issueTraeCallbackState(): { state: string; expiresAt: number } {
  prune();
  const state = randomUUID();
  const expiresAt = Date.now() + STATE_TTL_MS;
  store().set(state, expiresAt);
  return { state, expiresAt };
}

/** Atomically consume a live state. Missing, expired, and replayed states fail closed. */
export function consumeTraeCallbackState(state: string | null): boolean {
  if (!state) return false;
  const states = store();
  const expiresAt = states.get(state);
  if (expiresAt === undefined) return false;
  states.delete(state);
  return expiresAt > Date.now();
}

export function resetTraeCallbackStatesForTests(): void {
  store().clear();
}
