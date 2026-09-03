import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cache-settings-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const semanticCache = await import("../../src/lib/semanticCache.ts");
const core = await import("../../src/lib/db/core.ts");
const databaseSettings = await import("../../src/lib/db/databaseSettings.ts");
const readCache = await import("../../src/lib/db/readCache.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");

test.after(() => {
  delete process.env.SEMANTIC_CACHE_MAX_SIZE;
  delete process.env.SEMANTIC_CACHE_TTL_MS;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("dashboard semantic cache limits configure runtime and persisted TTL", async () => {
  databaseSettings.updateDatabaseSettings({
    cache: {
      semanticCacheEnabled: true,
      semanticCacheMaxSize: 37,
      semanticCacheTTL: 12_345,
      promptCacheEnabled: true,
      promptCacheStrategy: "auto",
      alwaysPreserveClientCache: "auto",
    },
  });

  const settings = await readCache.getCachedDatabaseCacheSettings();
  semanticCache.configureSemanticCache({
    maxSize: settings.semanticCacheMaxSize,
    ttlMs: settings.semanticCacheTTL,
  });
  assert.deepEqual(semanticCache.getSemanticCacheRuntimeConfig(), { maxSize: 37, ttlMs: 12_345 });
  assert.equal((await settingsDb.getSettings()).semanticCacheTTL, 12_345);

  semanticCache.setCachedResponse("settings-ttl", "model", { ok: true });
  const row = core
    .getDbInstance()
    .prepare("SELECT created_at, expires_at FROM semantic_cache WHERE signature = ?")
    .get("settings-ttl") as { created_at: string; expires_at: string };
  assert.equal(new Date(row.expires_at).getTime() - new Date(row.created_at).getTime(), 12_345);

  for (let index = 0; index < 40; index++) {
    semanticCache.setCachedResponse(`lru-${index}`, "model", { index });
  }
  assert.equal(semanticCache.getCacheStats().memoryEntries, 37);
});

test("environment variables remain explicit runtime overrides", () => {
  process.env.SEMANTIC_CACHE_MAX_SIZE = "12";
  process.env.SEMANTIC_CACHE_TTL_MS = "6789";
  assert.deepEqual(semanticCache.getSemanticCacheRuntimeConfig(), { maxSize: 12, ttlMs: 6_789 });
  delete process.env.SEMANTIC_CACHE_MAX_SIZE;
  delete process.env.SEMANTIC_CACHE_TTL_MS;
});

test("expired ISO timestamp rows are never served or counted as live", () => {
  const db = core.getDbInstance();
  const now = Date.now();
  const liveEntriesBefore = semanticCache.getCacheStats().dbEntries;
  db.prepare(
    `INSERT OR REPLACE INTO semantic_cache
      (id, signature, model, prompt_hash, response, tokens_saved, hit_count, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`
  ).run(
    "expired-row",
    "expired-signature",
    "model",
    "expired",
    JSON.stringify({ shouldNotBeServed: true }),
    new Date(now - 10_000).toISOString(),
    new Date(now - 1_000).toISOString()
  );

  assert.equal(semanticCache.getCachedResponse("expired-signature"), null);
  assert.equal(semanticCache.getCacheStats().dbEntries, liveEntriesBefore);
});

test("legacy flat cache settings are consolidated for the runtime", async () => {
  await settingsDb.updateSettings({ semanticCacheMaxSize: 23 });
  const settings = await readCache.getCachedDatabaseCacheSettings();
  assert.equal(settings.semanticCacheMaxSize, 23);
});
