/**
 * db/settings/lkgp.ts — Last Known Good Provider (LKGP) persistence.
 */

import { getDbInstance } from "../core";

export interface LKGPRecord {
  provider: string;
  connectionId?: string;
}

export async function getLKGP(comboName: string, modelId: string): Promise<LKGPRecord | null> {
  const db = getDbInstance();
  const key = `${comboName}:${modelId}`;
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = 'lkgp' AND key = ?")
    .get(key) as { value?: string } | undefined;
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (typeof parsed === "object" && parsed !== null && "provider" in parsed) {
      return parsed as LKGPRecord;
    }
    return { provider: String(parsed) };
  } catch {
    return { provider: row.value };
  }
}

export async function setLKGP(
  comboName: string,
  modelId: string,
  providerId: string,
  connectionId?: string
) {
  const db = getDbInstance();
  const key = `${comboName}:${modelId}`;
  const value: LKGPRecord = { provider: providerId };
  if (connectionId) value.connectionId = connectionId;
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('lkgp', ?, ?)").run(
    key,
    JSON.stringify(value)
  );
}

export function clearAllLKGP(): void {
  const db = getDbInstance();
  db.prepare("DELETE FROM key_value WHERE namespace = 'lkgp'").run();
}

/**
 * Delete one persisted LKGP pin after its target fails. `setLKGP` is only ever
 * called on success — nothing previously invalidated a pin once its provider
 * started failing, so a *separate* subsequent request kept re-selecting the
 * same just-failed provider via `applyStrategyOrdering.ts`'s LKGP reordering
 * (live incident: 3 consecutive requests all picked the same timed-out
 * opencode-zen/big-pickle target instead of failing over to another combo
 * model). Circuit breaker / model lockout deliberately don't react to this
 * failure class (request-scoped timeouts, see comboPredicates.ts), so nothing
 * else clears the stale pin.
 */
export async function clearLKGP(comboName: string, modelId: string): Promise<void> {
  const db = getDbInstance();
  const key = `${comboName}:${modelId}`;
  db.prepare("DELETE FROM key_value WHERE namespace = 'lkgp' AND key = ?").run(key);
  const { invalidateCachedLKGP } = await import("../readCache");
  invalidateCachedLKGP(key);
}
