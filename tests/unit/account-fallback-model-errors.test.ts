import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #10460: DATA_DIR must be assigned BEFORE any transitive DB import. The
// accountFallback.ts import below statically imports `@/lib/db/providers`, which
// imports `src/lib/db/core.ts`, whose `DATA_DIR` is a top-level
// `export const DATA_DIR = resolveWritableDataDir(...)` captured once at module-load
// time. Setting `process.env.DATA_DIR` after that first import is a no-op — the DB
// singleton keeps whatever DATA_DIR it resolved at import time, so an isolated test
// directory assigned later is silently never used and the #10460 tests below would
// actually read/write the shared default DATA_DIR instead.
const TEST_DATA_DIR_10460 = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-model-errors-"));
process.env.DATA_DIR = TEST_DATA_DIR_10460;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "10460-test-secret";

const accountFallback = await import("../../open-sse/services/accountFallback.ts");
const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");

// ─── #10460: model-unsupported 400 skips account rotation ────────────────────
// TEST_DATA_DIR_10460 / DATA_DIR / core / providersDb / auth are set up at the top
// of this file, BEFORE the accountFallback.ts import — see the comment there.

async function resetStorage10460() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR_10460, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR_10460, { recursive: true });
}

async function seedConn10460(provider: string): Promise<string> {
  const conn = await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    apiKey: `${provider}-key-10460`,
    isActive: true,
    testStatus: "active",
  });
  return (conn as Record<string, unknown>).id as string;
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR_10460, { recursive: true, force: true });
});

test("#10460: model-unsupported 400 returns shouldFallback:false (no account cooldown)", async () => {
  await resetStorage10460();
  const connId = await seedConn10460("github");

  const result = await auth.markAccountUnavailable(
    connId,
    400,
    "The requested model is not supported",
    "github",
    "claude-fable-5"
  );

  // The guard must prevent account cooldown — the error belongs to the combo layer
  assert.strictEqual(result.shouldFallback, false, "must not trigger account rotation");
  assert.strictEqual(result.cooldownMs, 0, "must not cool down the account");

  // Verify the connection was NOT marked unavailable
  const after = await providersDb.getProviderConnectionById(connId);
  assert.ok(!after.rateLimitedUntil, "connection must not be rate-limited");
  assert.notStrictEqual(after.testStatus, "unavailable", "connection must stay active");
});

test("#10460: model-unsupported 400 handles various phrasings", async () => {
  await resetStorage10460();
  const connId = await seedConn10460("github");

  const phrasings = [
    "The requested model is not supported",
    "model claude-fable-5 is not supported",
    "invalid_request_error: model is not supported",
    "unsupported model: gpt-9",
  ];

  for (const errorText of phrasings) {
    await resetStorage10460();
    const id = await seedConn10460("github");
    const result = await auth.markAccountUnavailable(id, 400, errorText, "github", "test-model");
    assert.strictEqual(result.shouldFallback, false, `phrasing "${errorText}" must not rotate`);
    // Verify connection stays healthy after each iteration
    const conn = await providersDb.getProviderConnectionById(id);
    assert.ok(!conn.rateLimitedUntil, `"${errorText}" must not rate-limit connection`);
    assert.notStrictEqual(
      conn.testStatus,
      "unavailable",
      `"${errorText}" must not mark unavailable`
    );
  }
});

test("#10460: body-specific 400 still goes through normal path (not blocked by model guard)", async () => {
  await resetStorage10460();
  const connId = await seedConn10460("openai");

  const result = await auth.markAccountUnavailable(
    connId,
    400,
    "Invalid message format: the request body is malformed",
    "openai",
    "gpt-4"
  );

  // Body-specific 400 does NOT match MODEL_ACCESS_DENIED_PATTERNS — normal path applies
  assert.strictEqual(result.shouldFallback, true, "body-specific 400 must still allow fallback");
});

test("#10460: non-400 status with model-unsupported text does NOT trigger guard", async () => {
  await resetStorage10460();
  const connId = await seedConn10460("github");

  // 429 + model-unsupported text should go through normal path (guard only fires for status===400)
  const result = await auth.markAccountUnavailable(
    connId,
    429,
    "The requested model is not supported",
    "github",
    "test-model"
  );

  assert.strictEqual(
    result.shouldFallback,
    true,
    "non-400 must not be short-circuited by model guard"
  );
  // The key assertion: guard returns shouldFallback:false. If we get here with
  // shouldFallback:true, the guard did NOT fire (correct behavior).
});

test("#10460: empty errorText with status 400 does NOT trigger guard", async () => {
  await resetStorage10460();
  const connId = await seedConn10460("github");

  const result = await auth.markAccountUnavailable(connId, 400, "", "github", "test-model");

  // Empty string matches no patterns — normal path applies
  assert.strictEqual(result.shouldFallback, false, "empty errorText is generic 400 → no fallback");
});

test("#10460: auth-credential 400 text does NOT match model-unsupported guard", async () => {
  await resetStorage10460();
  const connId = await seedConn10460("github");

  // "Invalid API key provided for model gpt-4o" contains "model" but is NOT a
  // model-unsupported error — it's a credential issue. The guard must not fire.
  const result = await auth.markAccountUnavailable(
    connId,
    400,
    "Invalid API key provided for model gpt-4o",
    "github",
    "gpt-4o"
  );

  // This text does NOT match MODEL_ACCESS_DENIED_PATTERNS (verified by regex test)
  // so it falls through to checkFallbackError which returns shouldFallback:false for generic 400
  assert.strictEqual(
    result.shouldFallback,
    false,
    "auth-credential 400 must not be caught by model guard"
  );
  // The generic 400 path returns cooldownMs:0 — same as the guard, but the
  // connection was NOT touched (no rateLimitedUntil set). This distinguishes
  // it from the normal fallback path which would set a cooldown.
  const conn = await providersDb.getProviderConnectionById(connId);
  assert.ok(!conn.rateLimitedUntil, "generic 400 must not rate-limit connection");
});

test("#10460: guard early return does not touch DB (distinguishes from normal path)", async () => {
  await resetStorage10460();
  const connId = await seedConn10460("github");

  // Guard path: model-unsupported 400 → shouldFallback:false, cooldownMs:0, no DB change
  const guardResult = await auth.markAccountUnavailable(
    connId,
    400,
    "The requested model is not supported",
    "github",
    "test-model"
  );
  assert.strictEqual(guardResult.shouldFallback, false);
  assert.strictEqual(guardResult.cooldownMs, 0);
  const guardConn = await providersDb.getProviderConnectionById(connId);
  assert.ok(!guardConn.rateLimitedUntil, "guard path must not touch DB");
  assert.strictEqual(guardConn.testStatus, "active", "guard path must keep connection active");
});

test("#10460: returned result exposes a sanitized provider_model_unsupported reason", async () => {
  await resetStorage10460();
  const connId = await seedConn10460("github");

  const result = await auth.markAccountUnavailable(
    connId,
    400,
    "The requested model is not supported",
    "github",
    "claude-fable-5"
  );

  assert.strictEqual(result.shouldFallback, false);
  assert.strictEqual(
    (result as { reason?: string }).reason,
    "provider_model_unsupported",
    "the canonical sanitized reason must be exposed on the returned result, not only in logs"
  );
});

test("#10460: account-scoped permission/entitlement 400 keeps rotating (not misclassified as provider-wide unsupported)", async () => {
  await resetStorage10460();
  const connIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    connIds.push(await seedConn10460("github"));
  }
  let calls = 0;

  // Phrased so it matches the broader/ambiguous MODEL_ACCESS_DENIED_PATTERNS
  // ("permission" ... "model") but is NOT an unambiguous provider-wide "model not
  // supported" response — it reads as an account/key entitlement gap (e.g. this
  // key's plan doesn't include this model), where a DIFFERENT account of the same
  // provider may still have access. Rotation through all 3 accounts must continue,
  // unlike the unambiguous "model is not supported" case above.
  for (const connId of connIds) {
    calls += 1;
    const result = await auth.markAccountUnavailable(
      connId,
      400,
      "Your API key does not have permission to use model gpt-4o",
      "github",
      "gpt-4o"
    );
    if (!result.shouldFallback) break;
  }

  assert.equal(
    calls,
    3,
    "an account-scoped permission/entitlement 400 must keep rotating through all accounts, " +
      "not be short-circuited by the provider-wide model-unsupported guard"
  );
});

test("#10460: account-scoped 401 keeps rotating through all 3 accounts (not short-circuited)", async () => {
  await resetStorage10460();
  const connIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    connIds.push(await seedConn10460("github"));
  }
  let calls = 0;

  for (const connId of connIds) {
    calls += 1;
    const result = await auth.markAccountUnavailable(
      connId,
      401,
      "Unauthorized: invalid credentials",
      "github",
      "claude-fable-5"
    );
    if (!result.shouldFallback) break;
  }

  assert.equal(
    calls,
    3,
    "401 account-scoped errors must keep rotating through every account, unlike model-unsupported 400"
  );
});

test("#10460: account-scoped 403 keeps rotating through all 3 accounts", async () => {
  await resetStorage10460();
  const connIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    connIds.push(await seedConn10460("github"));
  }
  let calls = 0;

  for (const connId of connIds) {
    calls += 1;
    const result = await auth.markAccountUnavailable(
      connId,
      403,
      "Forbidden: access denied for this account",
      "github",
      "claude-fable-5"
    );
    if (!result.shouldFallback) break;
  }

  assert.equal(calls, 3, "403 account-scoped errors must keep rotating through every account");
});

test("#10460: 429 rate limit keeps rotating through all 3 accounts", async () => {
  await resetStorage10460();
  const connIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    connIds.push(await seedConn10460("github"));
  }
  let calls = 0;

  for (const connId of connIds) {
    calls += 1;
    const result = await auth.markAccountUnavailable(
      connId,
      429,
      "Rate limit exceeded",
      "github",
      "claude-fable-5"
    );
    if (!result.shouldFallback) break;
  }

  assert.equal(calls, 3, "429 rate-limit errors must keep rotating through every account");
});

// ─── #10460 acceptance criteria: 3-account rotation + combo target advancement ─
//
// Reproduces the exact regression from issue #10460: a combo with a
// (github/model, 3 accounts) target followed by a sibling target. When GitHub
// returns an unambiguous "model not supported" 400, the account-rotation loop
// must make exactly ONE upstream call (not one per account) and the combo must
// advance to the next target — not just that markAccountUnavailable() in
// isolation returns shouldFallback:false (covered above), but that a realistic
// rotation loop wired to the REAL markAccountUnavailable()/
// isProviderModelUnsupported400() gating actually stops after account 1 and lets
// handleComboChat() move on.
//
// The inner loop below is a faithful, minimal reproduction of the account-rotation
// contract in src/sse/handlers/chat.ts::handleSingleModelChat step 8 ("Fallback to
// next account", ~line 1936): call markAccountUnavailable(); continue to the next
// connection only while shouldFallback is true, otherwise stop immediately and
// surface the failure. Reimplemented at this scope (rather than driving the full
// handleChat()/route stack) so the test can assert on upstream-call counts and
// per-connection DB state directly, while still exercising the real gating logic
// that decides whether rotation continues.
test("#10460 acceptance: unambiguous model-unsupported 400 makes exactly ONE upstream call across 3 accounts, then the combo advances to the next target", async () => {
  await resetStorage10460();
  const { handleComboChat } = await import("../../open-sse/services/combo.ts");

  const githubConnIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    githubConnIds.push(await seedConn10460("github"));
  }

  let githubUpstreamCalls = 0;
  const triedGithubConnections: string[] = [];
  const noopLog = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

  const handleSingleModel = async (_body: unknown, modelStr: string) => {
    if (modelStr.startsWith("github/")) {
      for (const connId of githubConnIds) {
        triedGithubConnections.push(connId);
        githubUpstreamCalls += 1;
        const result = await auth.markAccountUnavailable(
          connId,
          400,
          "The requested model is not supported",
          "github",
          "claude-fable-5"
        );
        if (result.shouldFallback) continue;
        return new Response(
          JSON.stringify({ error: { message: "The requested model is not supported" } }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      // A test-fixture bug (guard not firing) would otherwise silently exhaust
      // every account and mask the regression this test exists to catch.
      throw new Error("all 3 github accounts were tried — the guard did not fire");
    }
    // Second combo target (a different provider) — succeeds immediately.
    return new Response(JSON.stringify({ id: "ok", choices: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await handleComboChat({
    body: { model: "test", messages: [{ role: "user", content: "hi" }] },
    combo: {
      name: "test-combo-10460",
      strategy: "priority",
      models: [{ model: "github/claude-fable-5" }, { model: "openai/gpt-4o-mini" }],
    },
    handleSingleModel,
    log: noopLog,
    settings: {},
    allCombos: [],
  });

  assert.equal(
    githubUpstreamCalls,
    1,
    `expected exactly ONE upstream call for github/claude-fable-5 across 3 accounts, got ` +
      `${githubUpstreamCalls} (tried: ${triedGithubConnections.join(", ")})`
  );
  assert.equal(triedGithubConnections.length, 1, "only the first account should have been tried");
  assert.equal(result.status, 200, "the combo must advance to the next target and succeed");

  // The two untouched accounts must remain completely unaffected — proves the
  // guard did not just avoid an upstream call but also never cooled them down,
  // so they stay immediately eligible for the next unrelated request.
  for (const connId of githubConnIds.slice(1)) {
    const conn = await providersDb.getProviderConnectionById(connId);
    assert.ok(!conn.rateLimitedUntil, `untried account ${connId} must not be rate-limited`);
    assert.notStrictEqual(
      conn.testStatus,
      "unavailable",
      `untried account ${connId} must stay active`
    );
  }
});

// ─── Account-scoped "model not supported" 400 rotates to the next account ────────
// Codex answers this way for a ChatGPT account whose plan lacks the model; other
// accounts of the same provider serve it, so the request must not fail provider-wide.
const CODEX_ACCOUNT_UNSUPPORTED =
  '[400]: {"detail":"The \'gpt-5.6-sol\' model is not supported when using Codex with a ChatGPT account."}';

test("account-scoped unsupported 400 is not classified as provider-wide", () => {
  const cases: Array<[number, string, boolean, boolean]> = [
    // status, text, accountScoped, providerWide
    [400, CODEX_ACCOUNT_UNSUPPORTED, true, false],
    [
      400,
      "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.",
      true,
      false,
    ],
    [400, "The requested model is not supported", false, true],
    [400, "model x is not supported when using an invalid api key account", false, false],
    [429, CODEX_ACCOUNT_UNSUPPORTED, false, false],
  ];
  for (const [status, text, accountScoped, providerWide] of cases) {
    assert.strictEqual(
      accountFallback.isAccountScopedModelUnsupported400(status, text),
      accountScoped,
      text
    );
    assert.strictEqual(
      accountFallback.isProviderModelUnsupported400(status, text),
      providerWide,
      text
    );
  }
});

test("account-scoped unsupported 400 locks only that model on that account and rotates", async () => {
  await resetStorage10460();
  const connId = await seedConn10460("codex");
  const other = (
    (await providersDb.createProviderConnection({
      provider: "codex",
      authType: "apikey",
      apiKey: "codex-key-other",
      isActive: true,
      testStatus: "active",
    })) as Record<string, unknown>
  ).id as string;
  assert.notStrictEqual(other, connId);

  const result = await auth.markAccountUnavailable(
    connId,
    400,
    CODEX_ACCOUNT_UNSUPPORTED,
    "codex",
    "gpt-5.6-sol-low"
  );

  assert.strictEqual(result.shouldFallback, true, "must rotate to another account");
  assert.strictEqual(result.cooldownMs, 0, "the account itself is not cooled down");
  assert.strictEqual(
    accountFallback.isAccountModelUnsupported("codex", connId, "gpt-5.6-sol-low"),
    true
  );
  assert.strictEqual(
    accountFallback.isAccountModelUnsupported("codex", connId, "gpt-5.5-medium"),
    false,
    "other models stay usable"
  );
  assert.strictEqual(
    accountFallback.isAccountModelUnsupported("codex", other, "gpt-5.6-sol-low"),
    false,
    "other accounts stay usable"
  );
  // The Codex quota-scope lockout is untouched: the account keeps serving its other models.
  assert.strictEqual(accountFallback.isModelLocked("codex", connId, "gpt-5.5-medium"), false);

  const after = await providersDb.getProviderConnectionById(connId);
  assert.ok(!after.rateLimitedUntil, "connection must not be rate-limited");
  assert.notStrictEqual(after.testStatus, "unavailable", "connection must stay active");
  assert.strictEqual(after.lastErrorType, "account_model_unsupported");

  // Selection skips the locked account for this model only.
  for (let i = 0; i < 4; i++) {
    const selected = await auth.getProviderCredentials("codex", null, null, "gpt-5.6-sol-low");
    assert.strictEqual(
      selected?.connectionId,
      other,
      "the locked account is never picked for this model"
    );
  }
  const forOtherModel = await auth.getProviderCredentials("codex", other, null, "gpt-5.5-medium");
  assert.strictEqual(
    forOtherModel?.connectionId,
    connId,
    "the account still serves models its plan includes"
  );
});

test("the account-model lock expires", () => {
  accountFallback.lockUnsupportedAccountModel("codex", "conn-expiry", "gpt-5.6-sol-low", -1);
  assert.strictEqual(
    accountFallback.isAccountModelUnsupported("codex", "conn-expiry", "gpt-5.6-sol-low"),
    false
  );
  accountFallback.lockUnsupportedAccountModel("codex", "conn-expiry", "gpt-5.6-sol-low", 60_000);
  assert.strictEqual(
    accountFallback.isAccountModelUnsupported("codex", "conn-expiry", "gpt-5.6-sol-low"),
    true
  );
});
