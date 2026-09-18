import { getCombos } from "@/lib/db/combos";
import { getCombosCacheVersion } from "@/lib/db/readCache";

let combosCachePromise: Promise<unknown[]> | null = null;
let combosCacheTs = 0;
let combosCacheVersionSnapshot = -1;
const COMBOS_CACHE_TTL_MS = 10_000;

export async function getCombosCachedForChat(): Promise<unknown[]> {
  const now = Date.now();
  // Explicit non-null check: we intentionally cache and return the Promise
  // itself (to dedupe concurrent callers), so this is not a forgotten await.
  // The version check makes combo edits (create/update/delete/reorder) take
  // effect immediately instead of after the 10s TTL — otherwise a removed
  // target/model could keep being served as a "phantom" for up to 10s (#3147).
  if (
    combosCachePromise !== null &&
    now - combosCacheTs < COMBOS_CACHE_TTL_MS &&
    combosCacheVersionSnapshot === getCombosCacheVersion()
  ) {
    return combosCachePromise;
  }

  combosCacheTs = now;
  combosCacheVersionSnapshot = getCombosCacheVersion();
  combosCachePromise = getCombos().catch(() => []);
  return combosCachePromise;
}
