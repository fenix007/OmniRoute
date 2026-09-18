import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-sse-auth-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "sse-auth-test-secret";

export const core = await import("../../../src/lib/db/core.ts");
export const providersDb = await import("../../../src/lib/db/providers.ts");
export const settingsDb = await import("../../../src/lib/db/settings.ts");
export const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
export const auth = await import("../../../src/sse/services/auth.ts");
export const quotaCache = await import("../../../src/domain/quotaCache.ts");
export const fallback = await import("../../../open-sse/services/accountFallback.ts");

export async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

export function cleanupStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}

export function futureIso(ms = 60_000) {
  return new Date(Date.now() + ms).toISOString();
}

interface SeedConnectionOverrides {
  authType?: string;
  name?: string;
  email?: string | null;
  apiKey?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  isActive?: boolean;
  testStatus?: string;
  priority?: number;
  rateLimitedUntil?: string | null;
  lastError?: string | null;
  lastErrorType?: string | null;
  lastErrorSource?: string | null;
  errorCode?: string | number | null;
  backoffLevel?: number;
  providerSpecificData?: Record<string, unknown>;
  lastUsedAt?: string | null;
  consecutiveUseCount?: number;
}

export async function seedConnection(provider: string, overrides: SeedConnectionOverrides = {}) {
  return providersDb.createProviderConnection({
    provider,
    authType: overrides.authType || "apikey",
    name: overrides.name || `${provider}-${Math.random().toString(16).slice(2, 8)}`,
    email: overrides.email,
    // Real accounts use distinct credentials. Keep seeded credentials unique so
    // createProviderConnection does not collapse round-robin test accounts.
    apiKey: overrides.apiKey || `sk-test-${Math.random().toString(16).slice(2, 10)}`,
    accessToken: overrides.accessToken,
    refreshToken: overrides.refreshToken,
    isActive: overrides.isActive ?? true,
    testStatus: overrides.testStatus || "active",
    priority: overrides.priority,
    rateLimitedUntil: overrides.rateLimitedUntil,
    lastError: overrides.lastError,
    lastErrorType: overrides.lastErrorType,
    lastErrorSource: overrides.lastErrorSource,
    errorCode: overrides.errorCode,
    backoffLevel: overrides.backoffLevel,
    providerSpecificData: overrides.providerSpecificData || {},
    lastUsedAt: overrides.lastUsedAt,
    consecutiveUseCount: overrides.consecutiveUseCount,
  });
}

export function msUntil(timestamp: string) {
  return new Date(timestamp).getTime() - Date.now();
}

export async function flushWrites() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
