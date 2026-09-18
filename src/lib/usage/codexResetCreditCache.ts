// Routing reads this shared cache without importing the HTTP/credential refresh layer.
export interface CodexResetCreditList {
  availableCount: number;
  credits: Array<{ expiresAt: string | null }>;
}

const RESET_CREDIT_CACHE_TTL_MS = 15 * 60_000;
const resetCreditCache = new Map<string, { value: CodexResetCreditList; fetchedAt: number }>();

export function getCachedCodexResetCredits(connectionId: string): CodexResetCreditList | null {
  const cached = resetCreditCache.get(connectionId);
  if (!cached || Date.now() - cached.fetchedAt >= RESET_CREDIT_CACHE_TTL_MS) return null;
  return cached.value;
}

/** Store a fetched snapshot or clear a connection without loading the HTTP service. */
export function setCachedCodexResetCredits(
  connectionId: string,
  value: CodexResetCreditList | null
) {
  if (value === null) {
    resetCreditCache.delete(connectionId);
    return;
  }
  resetCreditCache.set(connectionId, { value, fetchedAt: Date.now() });
}
