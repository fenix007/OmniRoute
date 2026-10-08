import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-session-routing-usage-"));
process.env.DATA_DIR = testDataDir;

const coreDb = await import("../../src/lib/db/core.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const { markSessionRoutingDeduplicated, parseSessionRouting } =
  await import("../../src/lib/usage/sessionRouting.ts");

const sessionHash = "a".repeat(64);

before(async () => {
  await coreDb.ensureDbInitialized();
});

after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test("session routing validator accepts only the closed privacy-safe contract", () => {
  assert.deepEqual(
    parseSessionRouting({
      sessionHash,
      sessionSource: "prompt-cache",
      routingReason: "affinity_reused",
      previousConnectionId: "conn-old",
    }),
    {
      sessionHash,
      sessionSource: "prompt-cache",
      routingReason: "affinity_reused",
      previousConnectionId: "conn-old",
    }
  );

  assert.equal(
    parseSessionRouting({
      sessionHash: "raw-session-id",
      sessionSource: "header",
      routingReason: "affinity_created",
    }),
    null
  );
  assert.equal(
    parseSessionRouting({
      sessionHash,
      sessionSource: "request-body",
      routingReason: "affinity_created",
    }),
    null
  );
  assert.equal(
    parseSessionRouting({
      sessionHash,
      sessionSource: "header",
      routingReason: "affinity_created",
      rawPromptCacheKey: "must-not-persist",
    }),
    null
  );
});

test("dedup diagnostics preserve the waiter's session identity", () => {
  assert.deepEqual(
    markSessionRoutingDeduplicated(
      {
        sessionHash,
        sessionSource: "metadata",
        routingReason: "affinity_reused",
        previousConnectionId: null,
      },
      "conn-waiter"
    ),
    {
      sessionHash,
      sessionSource: "metadata",
      routingReason: "deduplicated",
      previousConnectionId: "conn-waiter",
    }
  );
});

test("usage history persists and maps validated session-routing diagnostics", async () => {
  const timestamp = new Date().toISOString();
  await usageHistory.saveRequestUsage({
    provider: "codex-routing",
    model: "gpt-test",
    connectionId: "conn-current",
    tokens: { input: 10, output: 2 },
    timestamp,
    sessionRouting: {
      sessionHash,
      sessionSource: "header",
      routingReason: "affinity_reassigned",
      previousConnectionId: "conn-previous",
    },
  });

  const [row] = await usageHistory.getUsageHistory({ provider: "codex-routing" });
  assert.equal(row.sessionHash, sessionHash);
  assert.equal(row.sessionSource, "header");
  assert.equal(row.routingReason, "affinity_reassigned");
  assert.equal(row.previousConnectionId, "conn-previous");

  const columns = coreDb
    .getDbInstance()
    .prepare("PRAGMA table_info(usage_history)")
    .all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  assert.equal(columnNames.has("session_hash"), true);
  assert.equal(columnNames.has("session_source"), true);
  assert.equal(columnNames.has("routing_reason"), true);
  assert.equal(columnNames.has("previous_connection_id"), true);
});

test("dedup backfills routing diagnostics without adding a billing row", async () => {
  const timestamp = new Date(Date.now() + 1000).toISOString();
  const baseEntry = {
    provider: "codex-backfill",
    model: "gpt-test",
    connectionId: "conn-current",
    tokens: { input: 7, output: 3 },
    timestamp,
  };

  await usageHistory.saveRequestUsage(baseEntry);
  await usageHistory.saveRequestUsage({
    ...baseEntry,
    sessionRouting: {
      sessionHash,
      sessionSource: "metadata" as const,
      routingReason: "affinity_reused" as const,
      previousConnectionId: null,
    },
  });

  const rows = await usageHistory.getUsageHistory({ provider: "codex-backfill" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionHash, sessionHash);
  assert.equal(rows[0].sessionSource, "metadata");
  assert.equal(rows[0].routingReason, "affinity_reused");
});

test("invalid extended routing metadata is discarded while usage remains accounted", async () => {
  await usageHistory.saveRequestUsage({
    provider: "codex-invalid-routing",
    model: "gpt-test",
    tokens: { input: 5, output: 1 },
    timestamp: new Date(Date.now() + 2000).toISOString(),
    sessionRouting: {
      sessionHash,
      sessionSource: "input",
      routingReason: "strategy",
      apiKey: "must-not-persist",
    } as never,
  });

  const [row] = await usageHistory.getUsageHistory({ provider: "codex-invalid-routing" });
  assert.ok(row, "usage row must still be persisted");
  assert.equal(row.sessionHash, null);
  assert.equal(row.sessionSource, null);
  assert.equal(row.routingReason, null);
});
