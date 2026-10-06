import test from "node:test";
import assert from "node:assert/strict";
import {
  CREDITS_RECOVERY_INTERVAL_MS,
  isCreditsRecoveryCandidate,
  selectCreditsRecoveryModel,
  hasCreditInferenceEvidence,
  probeCreditsRecovery,
  readCreditsProbePayload,
  runCreditsRecoveryTick,
  type CreditsRecoveryConnection,
} from "../../src/lib/quota/creditsRecovery.ts";

// Dynamic network-helper imports may load DB configuration; isolate it as well.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-credits-recovery-"));
process.env.DATA_DIR = testDataDir;
process.env.API_KEY_SECRET = "credits-recovery-test-secret";
test.after(async () => {
  const { resetDbInstance } = await import("../../src/lib/db/core.ts");
  resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

const conn: CreditsRecoveryConnection = {
  id: "account",
  provider: "openai-compatible-sale",
  authType: "apikey",
  isActive: true,
  testStatus: "credits_exhausted",
  apiKey: "test-key",
  providerSpecificData: { baseUrl: "https://example.org/v1", apiType: "chat" },
};
const completion = { object: "chat.completion", choices: [{ message: { content: "OK" } }] };
const combos = [{ models: [{ providerId: conn.provider, model: "gpt-6-luna" }] }];

test("only enabled exhausted API key compatible connections are eligible", () => {
  assert.equal(isCreditsRecoveryCandidate(conn), true);
  for (const patch of [
    { isActive: false },
    { testStatus: "banned" },
    { testStatus: "expired" },
    { testStatus: "error" },
    { authType: "oauth" },
    { provider: "codex" },
    { apiKey: "" },
    { healthCheckInterval: 0 },
  ])
    assert.equal(isCreditsRecoveryCandidate({ ...conn, ...patch }), false);
});

test("model selection supports persisted combo ids and aliases and account scope", () => {
  assert.equal(selectCreditsRecoveryModel(conn, combos), "gpt-6-luna");
  assert.equal(
    selectCreditsRecoveryModel(conn, [{ models: ["cs/gpt-5.4-mini"] }], "cs"),
    "gpt-5.4-mini"
  );
  assert.equal(
    selectCreditsRecoveryModel(conn, [
      { models: [{ model: `${conn.provider}/gpt`, connectionId: "other" }] },
    ]),
    null
  );
  assert.equal(
    selectCreditsRecoveryModel(conn, [
      { models: [{ model: `${conn.provider}/gpt`, allowedConnectionIds: ["other"] }] },
    ]),
    null
  );
  assert.equal(
    selectCreditsRecoveryModel(
      { ...conn, providerSpecificData: { validationModelId: "chosen" } },
      combos
    ),
    "chosen"
  );
});

test("credit evidence rejects models, empty output, auth-ish status and errors", () => {
  assert.equal(hasCreditInferenceEvidence(200, completion), true);
  for (const status of [400, 401, 402, 403, 429, 500])
    assert.equal(hasCreditInferenceEvidence(status, completion), false);
  for (const body of [
    null,
    "html",
    { data: [{ id: "gpt" }] },
    { ...completion, error: "quota" },
    { object: "chat.completion", choices: [{ message: { content: "" } }] },
    { object: "response", status: "completed", output: [] },
  ])
    assert.equal(hasCreditInferenceEvidence(200, body), false);
  assert.equal(
    hasCreditInferenceEvidence(200, {
      object: "response",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
    }),
    true
  );
});

test("probe is bounded authenticated inference, never models or client content", async () => {
  for (const apiType of ["chat", "responses"]) {
    let called = false;
    const result = await probeCreditsRecovery(
      { ...conn, providerSpecificData: { ...conn.providerSpecificData, apiType } },
      "gpt",
      async (url, options) => {
        called = true;
        assert.equal(
          url,
          `https://example.org/v1/${apiType === "responses" ? "responses" : "chat/completions"}`
        );
        assert.equal(options.method, "POST");
        assert.equal(options.timeoutMs, 15000);
        assert.equal(options.retry, false);
        assert.equal(options.allowRedirect, false);
        assert.equal((options.headers as Record<string, string>).Authorization, "Bearer test-key");
        const body = JSON.parse(options.body as string);
        assert.equal(body.model, "gpt");
        assert.equal(body.stream, false);
        if (apiType === "responses") {
          assert.equal(body.max_output_tokens, 64);
          assert.equal(body.store, false);
        } else assert.equal(body.max_tokens, 64);
        return Response.json(completion);
      }
    );
    assert.equal(called, true);
    assert.equal(result, true);
  }
  assert.equal(
    await probeCreditsRecovery(conn, "gpt", async () => {
      throw new Error("secret-upstream-error");
    }),
    false
  );
});

test("tick retries after top-up interval; only positive inference applies CAS recovery", async () => {
  const attempts = new Map<string, number>();
  let healthy = false;
  let restores = 0;
  let probes = 0;
  const deps = {
    attempts,
    loadConnections: async () => [conn],
    loadCombos: async () => combos,
    loadPrefix: async () => undefined,
    probe: async () => {
      probes++;
      return healthy;
    },
    recover: async () => {
      restores++;
      return true;
    },
  };
  assert.equal((await runCreditsRecoveryTick({ ...deps, nowMs: 1000 })).recovered, 0);
  healthy = true;
  assert.equal((await runCreditsRecoveryTick({ ...deps, nowMs: 2000 })).probed, 0);
  assert.equal(
    (await runCreditsRecoveryTick({ ...deps, nowMs: 1000 + CREDITS_RECOVERY_INTERVAL_MS }))
      .recovered,
    1
  );
  assert.equal(restores, 1);
  assert.equal(probes, 2);
});

test("CAS miss does not count recovery; no suitable model sends no request", async () => {
  const deps = {
    attempts: new Map<string, number>(),
    loadConnections: async () => [conn],
    loadCombos: async () => combos,
    loadPrefix: async () => undefined,
    probe: async () => true,
    recover: async () => false,
  };
  assert.equal((await runCreditsRecoveryTick(deps)).recovered, 0);
  assert.equal(
    (await runCreditsRecoveryTick({ ...deps, attempts: new Map(), loadCombos: async () => [] }))
      .probed,
    0
  );
});

test("one tick probes sequentially at most four accounts and isolates failures", async () => {
  let pending = 0;
  let max = 0;
  const result = await runCreditsRecoveryTick({
    attempts: new Map(),
    loadConnections: async () =>
      Array.from({ length: 8 }, (_, index) => ({ ...conn, id: `c${index}` })),
    loadCombos: async () => combos,
    loadPrefix: async () => undefined,
    probe: async () => {
      pending++;
      max = Math.max(max, pending);
      await Promise.resolve();
      pending--;
      throw new Error("network");
    },
    recover: async () => {
      assert.fail("failed probe must not restore");
    },
  });
  assert.equal(result.probed, 4);
  assert.equal(result.recovered, 0);
  assert.equal(max, 1);
});

test("strict recovery CAS rejects operator disable and credential/settings edits", async () => {
  const db = await import("../../src/lib/db/providers.ts");
  const { getDbInstance } = await import("../../src/lib/db/core.ts");
  for (const change of ["disable", "credentials", "unchanged"]) {
    const created = await db.createProviderConnection({
      provider: conn.provider,
      authType: "apikey",
      apiKey: "old-key",
      isActive: true,
      testStatus: "credits_exhausted",
      lastErrorAt: "2026-10-06T00:00:00Z",
    });
    const before = await db.getProviderConnectionById(String(created.id));
    if (change === "disable") {
      await db.updateProviderConnection(String(created.id), { isActive: false });
    } else if (change === "credentials") {
      await db.updateProviderConnection(String(created.id), { apiKey: "new-key" });
      // Force a distinct version even if the test updates within the same millisecond.
      getDbInstance()
        .prepare("UPDATE provider_connections SET updated_at = ? WHERE id = ?")
        .run("2026-10-06T12:00:00Z", created.id);
    }
    const applied = await db.clearConnectionErrorIfUnchanged(String(created.id), {
      testStatus: String(before.testStatus),
      lastErrorAt: before.lastErrorAt as string,
      rateLimitedUntil: before.rateLimitedUntil as string,
      isActive: true,
      updatedAt: before.updatedAt as string,
    });
    assert.equal(applied, change === "unchanged");
    const after = await db.getProviderConnectionById(String(created.id));
    assert.equal(after.testStatus, change === "unchanged" ? "active" : "credits_exhausted");
    if (change === "disable") assert.equal(after.isActive, false);
  }
});

test("probes oldest attempts first in a large eligible account pool", async () => {
  const now = 10 * CREDITS_RECOVERY_INTERVAL_MS;
  const attempts = new Map<string, number>([
    ["newer", now - CREDITS_RECOVERY_INTERVAL_MS],
    ["oldest", 1],
  ]);
  const order: string[] = [];
  await runCreditsRecoveryTick({
    nowMs: now,
    attempts,
    loadConnections: async () => ["newer", "oldest", "never"].map((id) => ({ ...conn, id })),
    loadCombos: async () => combos,
    loadPrefix: async () => undefined,
    probe: async (current) => {
      order.push(current.id);
      return false;
    },
    recover: async () => false,
  });
  assert.deepEqual(order, ["never", "oldest", "newer"]);
});

test("fallback probe model uses last persisted combo fallback when no explicit model", () => {
  const alternatives = [
    { models: [`${conn.provider}/gpt-6-luna`, `${conn.provider}/gpt-5.4-mini`] },
  ];
  assert.equal(selectCreditsRecoveryModel(conn, alternatives), "gpt-5.4-mini");
});

test("strict credit CAS clears only proven primary-key health", async () => {
  const db = await import("../../src/lib/db/providers.ts");
  const { getValidApiKey, recordKeyTerminal } =
    await import("../../open-sse/services/apiKeyRotator.ts");
  const created = await db.createProviderConnection({
    provider: conn.provider,
    authType: "apikey",
    apiKey: "primary-key",
    isActive: true,
    testStatus: "credits_exhausted",
    providerSpecificData: {
      ...conn.providerSpecificData,
      validationModelId: "gpt",
      extraApiKeys: ["other-key"],
      apiKeyHealth: {
        primary: { status: "invalid", failures: 3 },
        extra_0: { status: "invalid", failures: 7 },
      },
    },
  });
  recordKeyTerminal(String(created.id), "primary");
  const before = await db.getProviderConnectionById(String(created.id));
  const result = await runCreditsRecoveryTick({
    attempts: new Map(),
    loadConnections: async () => [before as unknown as CreditsRecoveryConnection],
    loadCombos: async () => [],
    loadPrefix: async () => undefined,
    probe: async () => true,
  });
  assert.equal(result.recovered, 1);
  const after = await db.getProviderConnectionById(String(created.id));
  const data = after.providerSpecificData as {
    apiKeyHealth: Record<string, { status: string }>;
    extraApiKeys: string[];
  };
  assert.equal(data.apiKeyHealth.primary, undefined);
  assert.equal(data.apiKeyHealth.extra_0.status, "invalid");
  assert.equal(data.extraApiKeys[0], "other-key");
  assert.equal(getValidApiKey(String(created.id), "primary-key")?.key, "primary-key");
});

test("oversized chunked 200 JSON is canceled and cannot restore credits", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(65 * 1024)));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { status: 200 }
  );
  assert.equal(await probeCreditsRecovery(conn, "gpt", async () => response), false);
  assert.equal(cancelled, true);
});

test("body-read timeout cancels a hung upstream stream", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    })
  );
  const abort = new AbortController();
  const read = readCreditsProbePayload(response, abort.signal);
  abort.abort();
  await assert.rejects(read, /deadline exceeded/);
  assert.equal(cancelled, true);
});
