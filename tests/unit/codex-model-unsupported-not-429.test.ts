import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-model-unsupported-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET ||= "codex-model-unsupported-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const accountModelSupport = await import("../../src/lib/db/accountModelSupport.ts");
const auth = await import("../../src/sse/services/auth.ts");
const chatHelpers = await import("../../src/sse/handlers/chatHelpers.ts");
const { executeImageWithCredentialFallback } = await import(
  "../../src/sse/services/imageCredentialRetry.ts"
);
const { isAccountScopedModelUnsupported400 } = await import(
  "../../open-sse/services/accountModelErrors.ts"
);

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function futureIso(ms = 60 * 60_000) {
  return new Date(Date.now() + ms).toISOString();
}

async function seedCodexConnection(overrides: Record<string, unknown> = {}) {
  return (await providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: overrides.name || `codex-${Math.random().toString(16).slice(2, 8)}`,
    accessToken: overrides.accessToken || `tok-${Math.random().toString(16).slice(2, 10)}`,
    isActive: overrides.isActive ?? true,
    testStatus: overrides.testStatus || "active",
    priority: overrides.priority,
    rateLimitedUntil: overrides.rateLimitedUntil,
    lastError: overrides.lastError,
    lastErrorType: overrides.lastErrorType,
    errorCode: overrides.errorCode,
    providerSpecificData: overrides.providerSpecificData || {},
  })) as { id: string; providerSpecificData?: Record<string, unknown> } & Record<string, unknown>;
}

test.beforeEach(async () => {
  await resetStorage();
  await settingsDb.updateSettings({
    fallbackStrategy: "priority",
  });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("returns modelUnsupported 400 (not 429 quota threshold) when all quota-eligible Codex accounts reject the model and remaining accounts are quota-filtered", async () => {
  const eligible = await seedCodexConnection({ name: "eligible-unsupported", priority: 1 });
  const quotaFiltered = await seedCodexConnection({
    name: "quota-filtered",
    priority: 2,
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 95, windows: ["session"] },
    },
  });

  accountModelSupport.saveAccountModelSupport("codex", eligible, "gpt-6.1", {
    status: "unsupported",
    reason: "account_model_unsupported",
    httpStatus: 400,
  });
  quotaCache.setQuotaCache(quotaFiltered.id, "codex", {
    session: { remainingPercentage: 1, resetAt: futureIso(106 * 60_000) },
  });

  const result = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    null,
    "gpt-6.1",
    { reportModelUnsupported: true }
  );

  assert.ok(result && "modelUnsupported" in result && result.modelUnsupported);
  assert.equal("allRateLimited" in result, false);
  assert.equal(result.lastErrorCode, 400);
  assert.equal(
    result.lastError,
    "The 'gpt-6.1' model is not supported when using Codex with a ChatGPT account."
  );
  assert.equal(isAccountScopedModelUnsupported400(result.lastErrorCode, result.lastError), true);

  const response = chatHelpers.handleNoCredentials(result, null, "codex", "gpt-6.1", null, null);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("Retry-After"), null);
  const body = await response.json();
  assert.match(
    JSON.stringify(body),
    /The 'gpt-6\.1' model is not supported when using Codex with a ChatGPT account\./
  );

  // Backwards compatibility: callers that do not opt into reportModelUnsupported never receive modelUnsupported.
  const legacy = await auth.getProviderCredentials("codex", null, null, "gpt-6.1");
  assert.ok(legacy && "allRateLimited" in legacy && legacy.allRateLimited);
  assert.equal("modelUnsupported" in legacy, false);
});

test("returns modelUnsupported 400 when eligible Codex account rejects model during live preflight diagnosis and remaining account is quota-filtered", async () => {
  const eligible = await seedCodexConnection({ name: "live-unsupported", priority: 1 });
  const quotaFiltered = await seedCodexConnection({
    name: "quota-filtered-live",
    priority: 2,
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 95, windows: ["session"] },
    },
  });
  quotaCache.setQuotaCache(quotaFiltered.id, "codex", {
    session: { remainingPercentage: 1, resetAt: futureIso(106 * 60_000) },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          message:
            "The 'gpt-6.1' model is not supported when using Codex with a ChatGPT account.",
        },
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  try {
    const result = await auth.getProviderCredentialsWithQuotaPreflight(
      "codex",
      null,
      null,
      "gpt-6.1",
      { reportModelUnsupported: true }
    );
    assert.ok(result && "modelUnsupported" in result && result.modelUnsupported);
    assert.equal("allRateLimited" in result, false);
    assert.equal(result.lastErrorCode, 400);
    assert.equal(
      accountModelSupport.getAccountModelSupport("codex", eligible, "gpt-6.1")?.status,
      "unsupported"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preserves 429 cooldown when a known-supported sibling is cooling down alongside an unsupported account", async () => {
  const unsupported = await seedCodexConnection({ name: "unsupported-a", priority: 1 });
  const supportedCooling = await seedCodexConnection({
    name: "supported-b-cooling",
    priority: 2,
    rateLimitedUntil: futureIso(30 * 60_000),
    errorCode: 429,
    lastError: "Rate limit exceeded",
  });

  accountModelSupport.saveAccountModelSupport("codex", unsupported, "gpt-6.1", {
    status: "unsupported",
    reason: "account_model_unsupported",
    httpStatus: 400,
  });
  accountModelSupport.saveAccountModelSupport("codex", supportedCooling, "gpt-6.1", {
    status: "supported",
    reason: "probe_completed",
    httpStatus: 200,
  });

  const result = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    null,
    "gpt-6.1",
    { reportModelUnsupported: true }
  );

  assert.ok(result && "allRateLimited" in result && result.allRateLimited);
  assert.equal("modelUnsupported" in result, false);
  assert.equal(Number(result.lastErrorCode), 429);
  assert.ok(result.retryAfter);
});

test("preserves 429 and earlier Retry-After in 3-account pool (A unsupported, B known-supported in 429 cooldown, C quota-filtered)", async () => {
  const unsupportedA = await seedCodexConnection({ name: "unsupported-a", priority: 1 });
  const bReset = futureIso(15 * 60_000);
  const supportedCoolingB = await seedCodexConnection({
    name: "supported-b-cooling",
    priority: 2,
    rateLimitedUntil: bReset,
    errorCode: 429,
    lastError: "Rate limit exceeded",
  });
  const quotaFilteredC = await seedCodexConnection({
    name: "quota-filtered-c",
    priority: 3,
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 95, windows: ["session"] },
    },
  });

  accountModelSupport.saveAccountModelSupport("codex", unsupportedA, "gpt-6.1", {
    status: "unsupported",
    reason: "account_model_unsupported",
    httpStatus: 400,
  });
  accountModelSupport.saveAccountModelSupport("codex", supportedCoolingB, "gpt-6.1", {
    status: "supported",
    reason: "probe_completed",
    httpStatus: 200,
  });
  quotaCache.setQuotaCache(quotaFilteredC.id, "codex", {
    session: { remainingPercentage: 1, resetAt: futureIso(106 * 60_000) },
  });

  const result = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    null,
    "gpt-6.1",
    { reportModelUnsupported: true }
  );

  assert.ok(result && "allRateLimited" in result && result.allRateLimited);
  assert.equal("modelUnsupported" in result, false);
  assert.equal(Number(result.lastErrorCode), 429);
  assert.equal(result.retryAfter, bReset);
});

test("preserves earlier codexScopeRateLimitedUntil Retry-After in 3-account pool (A unsupported, B scoped 429 cooldown 15m, C quota-filtered 106m)", async () => {
  const unsupportedA = await seedCodexConnection({ name: "unsupported-a-scoped", priority: 1 });
  const bScopedReset = futureIso(15 * 60_000);
  const supportedScopedCoolingB = await seedCodexConnection({
    name: "supported-b-scoped-cooling",
    priority: 2,
    providerSpecificData: {
      codexScopeRateLimitedUntil: { codex: bScopedReset },
    },
  });
  const quotaFilteredC = await seedCodexConnection({
    name: "quota-filtered-c-scoped",
    priority: 3,
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 95, windows: ["session"] },
    },
  });

  accountModelSupport.saveAccountModelSupport("codex", unsupportedA, "gpt-6.1", {
    status: "unsupported",
    reason: "account_model_unsupported",
    httpStatus: 400,
  });
  accountModelSupport.saveAccountModelSupport("codex", supportedScopedCoolingB, "gpt-6.1", {
    status: "supported",
    reason: "probe_completed",
    httpStatus: 200,
  });
  quotaCache.setQuotaCache(quotaFilteredC.id, "codex", {
    session: { remainingPercentage: 1, resetAt: futureIso(106 * 60_000) },
  });

  const result = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    null,
    "gpt-6.1",
    { reportModelUnsupported: true }
  );

  assert.ok(result && "allRateLimited" in result && result.allRateLimited);
  assert.equal("modelUnsupported" in result, false);
  assert.equal(Number(result.lastErrorCode), 429);
  assert.equal(result.retryAfter, bScopedReset);
});

test("uses max(15m, 60m) = 60m on availableConnections.length === 0 branch (2-account pool: A unsupported, B general 15m + scoped 60m)", async () => {
  const unsupportedA = await seedCodexConnection({ name: "unsupported-a-2acc", priority: 1 });
  const bConnReset = futureIso(15 * 60_000);
  const bScopedReset = futureIso(60 * 60_000);
  const supportedB = await seedCodexConnection({
    name: "supported-b-2acc",
    priority: 2,
    rateLimitedUntil: bConnReset,
    errorCode: 429,
    lastError: "Rate limit exceeded",
    providerSpecificData: {
      codexScopeRateLimitedUntil: { codex: bScopedReset },
    },
  });

  accountModelSupport.saveAccountModelSupport("codex", unsupportedA, "gpt-6.1", {
    status: "unsupported",
    reason: "account_model_unsupported",
    httpStatus: 400,
  });
  accountModelSupport.saveAccountModelSupport("codex", supportedB, "gpt-6.1", {
    status: "supported",
    reason: "probe_completed",
    httpStatus: 200,
  });

  const result = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    null,
    "gpt-6.1",
    { reportModelUnsupported: true }
  );

  assert.ok(result && "allRateLimited" in result && result.allRateLimited);
  assert.equal("modelUnsupported" in result, false);
  assert.equal(Number(result.lastErrorCode), 429);
  assert.equal(result.retryAfter, bScopedReset);
});

test("uses latest blocking quota window on B (session 30m + weekly 60m + cooldown 15m -> 60m) over C (106m)", async () => {
  const unsupportedA = await seedCodexConnection({ name: "unsupported-a-qwin", priority: 1 });
  const bConnReset = futureIso(15 * 60_000);
  const bSessionReset = futureIso(30 * 60_000);
  const bWeeklyReset = futureIso(60 * 60_000);
  const supportedB = await seedCodexConnection({
    name: "supported-b-qwin",
    priority: 2,
    rateLimitedUntil: bConnReset,
    errorCode: 429,
    lastError: "Rate limit exceeded",
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 95, windows: ["session", "weekly"] },
    },
  });
  const quotaFilteredC = await seedCodexConnection({
    name: "quota-filtered-c-qwin",
    priority: 3,
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 95, windows: ["session"] },
    },
  });

  accountModelSupport.saveAccountModelSupport("codex", unsupportedA, "gpt-6.1", {
    status: "unsupported",
    reason: "account_model_unsupported",
    httpStatus: 400,
  });
  accountModelSupport.saveAccountModelSupport("codex", supportedB, "gpt-6.1", {
    status: "supported",
    reason: "probe_completed",
    httpStatus: 200,
  });
  quotaCache.setQuotaCache(supportedB.id, "codex", {
    session: { remainingPercentage: 1, resetAt: bSessionReset },
    weekly: { remainingPercentage: 1, resetAt: bWeeklyReset },
  });
  quotaCache.setQuotaCache(quotaFilteredC.id, "codex", {
    session: { remainingPercentage: 1, resetAt: futureIso(106 * 60_000) },
  });

  const result = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    null,
    "gpt-6.1",
    { reportModelUnsupported: true }
  );

  assert.ok(result && "allRateLimited" in result && result.allRateLimited);
  assert.equal("modelUnsupported" in result, false);
  assert.equal(Number(result.lastErrorCode), 429);
  assert.equal(result.retryAfter, bWeeklyReset);
});

test("parses numeric epoch-ms .0 cooldown strings on B (15m) instead of falling back to C (106m)", async () => {
  const unsupportedA = await seedCodexConnection({ name: "unsupported-a-epoch", priority: 1 });
  const bEpochMs = Date.now() + 15 * 60_000;
  const supportedB = await seedCodexConnection({
    name: "supported-b-epoch",
    priority: 2,
    rateLimitedUntil: `${bEpochMs}.0`,
    errorCode: 429,
    lastError: "Rate limit exceeded",
  });
  const quotaFilteredC = await seedCodexConnection({
    name: "quota-filtered-c-epoch",
    priority: 3,
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 95, windows: ["session"] },
    },
  });

  accountModelSupport.saveAccountModelSupport("codex", unsupportedA, "gpt-6.1", {
    status: "unsupported",
    reason: "account_model_unsupported",
    httpStatus: 400,
  });
  accountModelSupport.saveAccountModelSupport("codex", supportedB, "gpt-6.1", {
    status: "supported",
    reason: "probe_completed",
    httpStatus: 200,
  });
  quotaCache.setQuotaCache(quotaFilteredC.id, "codex", {
    session: { remainingPercentage: 1, resetAt: futureIso(106 * 60_000) },
  });

  const result = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    null,
    "gpt-6.1",
    { reportModelUnsupported: true }
  );

  assert.ok(result && "allRateLimited" in result && result.allRateLimited);
  assert.equal("modelUnsupported" in result, false);
  assert.equal(Number(result.lastErrorCode), 429);
  assert.equal(result.retryAfter, new Date(bEpochMs).toISOString());
});

test("uses the latest active constraint per supported account (max(15m, 60m) = 60m) before choosing earliest across the pool (min(60m, 106m) = 60m)", async () => {
  const unsupportedA = await seedCodexConnection({ name: "unsupported-a-multi", priority: 1 });
  const bConnReset = futureIso(15 * 60_000);
  const bScopedReset = futureIso(60 * 60_000);
  const supportedMultiBlockedB = await seedCodexConnection({
    name: "supported-b-multi-blocked",
    priority: 2,
    rateLimitedUntil: bConnReset,
    errorCode: 429,
    lastError: "Rate limit exceeded",
    providerSpecificData: {
      codexScopeRateLimitedUntil: { codex: bScopedReset },
    },
  });
  const quotaFilteredC = await seedCodexConnection({
    name: "quota-filtered-c-multi",
    priority: 3,
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 95, windows: ["session"] },
    },
  });

  accountModelSupport.saveAccountModelSupport("codex", unsupportedA, "gpt-6.1", {
    status: "unsupported",
    reason: "account_model_unsupported",
    httpStatus: 400,
  });
  accountModelSupport.saveAccountModelSupport("codex", supportedMultiBlockedB, "gpt-6.1", {
    status: "supported",
    reason: "probe_completed",
    httpStatus: 200,
  });
  quotaCache.setQuotaCache(quotaFilteredC.id, "codex", {
    session: { remainingPercentage: 1, resetAt: futureIso(106 * 60_000) },
  });

  const result = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    null,
    "gpt-6.1",
    { reportModelUnsupported: true }
  );

  assert.ok(result && "allRateLimited" in result && result.allRateLimited);
  assert.equal("modelUnsupported" in result, false);
  assert.equal(Number(result.lastErrorCode), 429);
  assert.equal(result.retryAfter, bScopedReset);
});

test("ignores model-excluded cooling sibling B so irrelevant cooldown cannot suppress A modelUnsupported", async () => {
  const unsupportedA = await seedCodexConnection({ name: "unsupported-a", priority: 1 });
  const excludedCoolingB = await seedCodexConnection({
    name: "excluded-b-cooling",
    priority: 2,
    rateLimitedUntil: futureIso(45 * 60_000),
    errorCode: 429,
    lastError: "Rate limit exceeded",
    providerSpecificData: {
      excludedModels: ["gpt-6.1"],
    },
  });

  accountModelSupport.saveAccountModelSupport("codex", unsupportedA, "gpt-6.1", {
    status: "unsupported",
    reason: "account_model_unsupported",
    httpStatus: 400,
  });
  accountModelSupport.saveAccountModelSupport("codex", excludedCoolingB, "gpt-6.1", {
    status: "supported",
    reason: "probe_completed",
    httpStatus: 200,
  });

  const result = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    null,
    "gpt-6.1",
    { reportModelUnsupported: true }
  );

  assert.ok(result && "modelUnsupported" in result && result.modelUnsupported);
  assert.equal("allRateLimited" in result, false);
  assert.equal(result.lastErrorCode, 400);
});

test("preserves 429 when unsupported account is also quota-exhausted/rate-limited (not otherwise eligible)", async () => {
  const bothBlocked = await seedCodexConnection({
    name: "unsupported-and-quota-blocked",
    priority: 1,
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 95, windows: ["session"] },
    },
  });
  const quotaOnly = await seedCodexConnection({
    name: "quota-blocked-b",
    priority: 2,
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 95, windows: ["session"] },
    },
  });

  accountModelSupport.saveAccountModelSupport("codex", bothBlocked, "gpt-6.1", {
    status: "unsupported",
    reason: "account_model_unsupported",
    httpStatus: 400,
  });
  quotaCache.setQuotaCache(bothBlocked.id, "codex", {
    session: { remainingPercentage: 0, resetAt: futureIso(60 * 60_000) },
  });
  quotaCache.setQuotaCache(quotaOnly.id, "codex", {
    session: { remainingPercentage: 0, resetAt: futureIso(60 * 60_000) },
  });

  const result = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    null,
    "gpt-6.1",
    { reportModelUnsupported: true }
  );

  assert.ok(result && "allRateLimited" in result && result.allRateLimited);
  assert.equal(result.lastErrorCode, 429);
});

test("handleNoCredentials preserves actual execution 429 from a supported account over a subsequent modelUnsupported sentinel", async () => {
  const response = chatHelpers.handleNoCredentials(
    {
      modelUnsupported: true,
      unsupportedCount: 1,
      lastErrorCode: 400,
      lastError: "The 'gpt-6.1' model is not supported when using Codex with a ChatGPT account.",
    },
    "conn-b",
    "codex",
    "gpt-6.1",
    "Upstream rate limit exceeded",
    429
  );
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.match(JSON.stringify(body), /Upstream rate limit exceeded/);
});

test("merges cached 404 and live 400 rejections by ID and returns canonical 400 with combined count", async () => {
  const cached404 = await seedCodexConnection({ name: "cached-404", priority: 1 });
  const live400 = await seedCodexConnection({ name: "live-400", priority: 2 });

  accountModelSupport.saveAccountModelSupport("codex", cached404, "gpt-6.1", {
    status: "unsupported",
    reason: "account_model_unsupported",
    httpStatus: 404,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          message:
            "The 'gpt-6.1' model is not supported when using Codex with a ChatGPT account.",
        },
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  try {
    const result = await auth.getProviderCredentialsWithQuotaPreflight(
      "codex",
      null,
      null,
      "gpt-6.1",
      { reportModelUnsupported: true }
    );
    assert.ok(result && "modelUnsupported" in result && result.modelUnsupported);
    assert.equal(result.unsupportedCount, 2);
    assert.equal(result.lastErrorCode, 400);
    assert.equal(
      accountModelSupport.getAccountModelSupport("codex", live400, "gpt-6.1")?.httpStatus,
      400
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns modelUnsupported 404 when every rejected Codex account reported 404", async () => {
  const first = await seedCodexConnection({ name: "first-404", priority: 1 });
  accountModelSupport.saveAccountModelSupport("codex", first, "gpt-6.1", {
    status: "unsupported",
    reason: "account_model_unsupported",
    httpStatus: 404,
  });

  const result = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    null,
    "gpt-6.1",
    { reportModelUnsupported: true }
  );

  assert.ok(result && "modelUnsupported" in result && result.modelUnsupported);
  assert.equal(result.lastErrorCode, 404);
  const response = chatHelpers.handleNoCredentials(result, null, "codex", "gpt-6.1", null, null);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Retry-After"), null);
});

test("image selection and retry surface cached 404 modelUnsupported instead of generic 400/401", async () => {
  const denied404 = await seedCodexConnection({ name: "img-denied-404", priority: 1 });
  accountModelSupport.saveAccountModelSupport("codex", denied404, "gpt-6.1", {
    status: "unsupported",
    reason: "account_model_unsupported",
    httpStatus: 404,
  });

  // Initial image route selection path (with skipModelDiagnostics + reportModelUnsupported)
  const initialSelected = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    null,
    "gpt-6.1",
    { skipModelDiagnostics: true, reportModelUnsupported: true }
  );
  assert.ok(initialSelected && "modelUnsupported" in initialSelected && initialSelected.modelUnsupported);
  assert.equal(initialSelected.lastErrorCode, 404);

  // Dynamic boolean flag preserves ModelUnsupportedResult in the union type as well as runtime behavior
  const dynamicFlag: boolean = true;
  const dynamicSelected = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    null,
    "gpt-6.1",
    { skipModelDiagnostics: true, reportModelUnsupported: dynamicFlag }
  );
  assert.ok(dynamicSelected && "modelUnsupported" in dynamicSelected && dynamicSelected.modelUnsupported);

  // Retry path inside executeImageWithCredentialFallback after first account fails with 401
  const failing401 = await seedCodexConnection({
    name: "img-first-401",
    priority: 0,
    accessToken: "fresh-token",
    expiresAt: futureIso(60 * 60_000),
  });
  const firstCreds = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    null,
    "gpt-6.1",
    { skipModelDiagnostics: true, reportModelUnsupported: true }
  );
  assert.equal(firstCreds && "connectionId" in firstCreds ? firstCreds.connectionId : null, failing401.id);

  let executed = 0;
  const outcome = await executeImageWithCredentialFallback({
    provider: "codex",
    requestedModel: "gpt-6.1",
    credentials: initialSelected,
    execute: async () => {
      executed += 1;
      return { success: true };
    },
  });
  assert.equal(executed, 0);
  assert.equal(outcome.result.success, false);
  assert.equal(outcome.result.status, 404);
  assert.match(String(outcome.result.error), /does not exist|access/);
});

test("preserves 429 quota threshold response when all Codex accounts are quota-filtered and none rejected the model", async () => {
  const quotaFiltered = await seedCodexConnection({
    name: "only-quota-filtered",
    priority: 1,
    providerSpecificData: {
      limitPolicy: { enabled: true, thresholdPercent: 95, windows: ["session"] },
    },
  });
  quotaCache.setQuotaCache(quotaFiltered.id, "codex", {
    session: { remainingPercentage: 1, resetAt: futureIso(90 * 60_000) },
  });

  const result = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    null,
    "gpt-6.1",
    { reportModelUnsupported: true }
  );

  assert.ok(result && "allRateLimited" in result && result.allRateLimited);
  assert.equal(result.lastErrorCode, 429);
  assert.match(result.lastError, /All codex accounts reached configured quota threshold/);
});

test("ignores confirmed unsupported account 503 cooldown (2m) when supported account is quota-blocked (60m)", async () => {
  const unsupportedA = await seedCodexConnection({
    name: "unsupported-a-503",
    priority: 1,
    rateLimitedUntil: futureIso(2 * 60_000),
    errorCode: 503,
    lastError: "Upstream unavailable",
  });
  const bQuotaReset = futureIso(60 * 60_000);
  const supportedB = await seedCodexConnection({
    name: "supported-b-quota-60m",
    priority: 2,
    providerSpecificData: { limitPolicy: { enabled: true, thresholdPercent: 95, windows: ["session"] } },
  });
  accountModelSupport.saveAccountModelSupport("codex", unsupportedA, "gpt-6.1", {
    status: "unsupported",
    reason: "account_model_unsupported",
    httpStatus: 400,
  });
  accountModelSupport.saveAccountModelSupport("codex", supportedB, "gpt-6.1", {
    status: "supported",
    reason: "probe_completed",
    httpStatus: 200,
  });
  quotaCache.setQuotaCache(supportedB.id, "codex", { session: { remainingPercentage: 1, resetAt: bQuotaReset } });

  const result = await auth.getProviderCredentialsWithQuotaPreflight("codex", null, null, "gpt-6.1", { reportModelUnsupported: true });
  assert.ok(result && "allRateLimited" in result && result.allRateLimited);
  assert.equal(Number(result.lastErrorCode), 429);
  assert.equal(result.retryAfter, bQuotaReset);
});

test("ignores confirmed unsupported account 429 cooldown (2m) when supported account is rate-limited (60m)", async () => {
  const unsupportedA = await seedCodexConnection({
    name: "unsupported-a-429",
    priority: 1,
    rateLimitedUntil: futureIso(2 * 60_000),
    errorCode: 429,
    lastError: "Rate limit exceeded",
  });
  const bReset = futureIso(60 * 60_000);
  const supportedB = await seedCodexConnection({
    name: "supported-b-429-60m",
    priority: 2,
    rateLimitedUntil: bReset,
    errorCode: 429,
    lastError: "Rate limit exceeded",
  });
  accountModelSupport.saveAccountModelSupport("codex", unsupportedA, "gpt-6.1", {
    status: "unsupported",
    reason: "account_model_unsupported",
    httpStatus: 400,
  });
  accountModelSupport.saveAccountModelSupport("codex", supportedB, "gpt-6.1", {
    status: "supported",
    reason: "probe_completed",
    httpStatus: 200,
  });

  const result = await auth.getProviderCredentialsWithQuotaPreflight("codex", null, null, "gpt-6.1", { reportModelUnsupported: true });
  assert.ok(result && "allRateLimited" in result && result.allRateLimited);
  assert.equal(Number(result.lastErrorCode), 429);
  assert.equal(result.retryAfter, bReset);
});
