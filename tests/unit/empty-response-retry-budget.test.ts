import test from "node:test";
import assert from "node:assert/strict";
import {
  EmptyResponseRetryBudget,
  EMPTY_RESPONSE_RETRY_EXHAUSTED,
} from "../../open-sse/services/combo/emptyResponseRetryBudget.ts";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const h = await createChatPipelineHarness("empty-response-budget");
const { getCallLogs } = await import("../../src/lib/usage/callLogs.ts");
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { createErrorResult } = await import("../../open-sse/utils/error.ts");
const log = { info() {}, warn() {}, debug() {}, error() {} };

test.beforeEach(async () => {
  await h.resetStorage();
});
test.after(async () => {
  await h.cleanup();
});

test("empty failure budget is isolated by request, provider and model; overload does not consume it", () => {
  const budget = new EmptyResponseRetryBudget();
  for (let i = 0; i < 8; i++)
    assert.equal(
      budget.recordFailure("codex", "astra", { status: 502, error: "overloaded" }),
      false
    );
  for (let i = 0; i < 3; i++) {
    assert.equal(
      budget.recordFailure("codex", "astra", { status: 502, errorCode: "empty_response" }),
      i === 2
    );
  }
  assert.equal(budget.isExhausted("codex", "astra"), true);
  assert.equal(budget.isExhausted("sale", "astra"), false);
  assert.equal(budget.isExhausted("codex", "terra"), false);
  assert.equal(new EmptyResponseRetryBudget().isExhausted("codex", "astra"), false);
});

function emptyResponse() {
  return Response.json({
    object: "response",
    status: "completed",
    model: "gpt-4.1",
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "" }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 4 },
  });
}

async function seedPrimary() {
  for (let i = 0; i < 5; i++)
    await h.seedConnection("openai", {
      apiKey: `sk-primary-${i}`,
      name: `primary-${i}`,
      priority: i,
    });
}

function request(model: string) {
  return h.buildRequest({
    body: { model, stream: false, messages: [{ role: "user", content: "Reply OK" }] },
  });
}

test("real chat pipeline caps empty output at three attempts across accounts, then serves the combo fallback and persists reasons", async () => {
  await seedPrimary();
  await h.seedConnection("claude", { apiKey: "sk-backup" });
  await h.combosDb.createCombo({
    name: "empty-fallback",
    strategy: "priority",
    config: { maxRetries: 5, retryDelayMs: 0, failoverBeforeRetry: false },
    models: ["openai/gpt-4.1", "claude/claude-3-5-sonnet-20241022"],
  });
  const primaryAccounts: string[] = [];
  let fallbackCalls = 0;
  globalThis.fetch = async (_url, init = {}) => {
    const headers = h.toPlainHeaders(init.headers) as Record<string, string>;
    if (headers["x-api-key"] === "sk-backup") {
      fallbackCalls++;
      return h.buildClaudeResponse("Fallback OK");
    }
    primaryAccounts.push(headers.authorization);
    return emptyResponse();
  };
  const response = await h.handleChat(request("empty-fallback"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "Fallback OK");
  assert.equal(primaryAccounts.length, 3, "account retry and combo retry must share a limit");
  assert.equal(
    new Set(primaryAccounts).size,
    3,
    "empty output rotates accounts without spending the transport retry on the same account"
  );
  assert.equal(fallbackCalls, 1);
  await h.waitFor(async () => (await getCallLogs({ status: 502 })).length >= 3);
  const rows = await getCallLogs({ status: 502 });
  assert.equal(rows.length, 3);
  for (const row of rows) assert.match(String(row.error), /returned an empty response/);
});

test("explicit overload switches accounts before retrying instead of using the transport retry", async () => {
  await seedPrimary();
  const accounts: string[] = [];
  globalThis.fetch = async (_url, init = {}) => {
    const headers = h.toPlainHeaders(init.headers) as Record<string, string>;
    accounts.push(headers.authorization);
    return accounts.length === 1
      ? new Response(
          JSON.stringify({
            error: { code: "server_error", message: "Servers are overloaded right now" },
          }),
          {
            status: 502,
            headers: { "Content-Type": "application/json" },
          }
        )
      : h.buildOpenAIResponse("Recovered on another account");
  };
  const response = await h.handleChat(request("openai/gpt-4.1"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "Recovered on another account");
  assert.equal(accounts.length, 2);
  assert.equal(new Set(accounts).size, 2);
});

test("standalone model stops after three empty attempts and returns an explicit exhausted code", async () => {
  await seedPrimary();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return emptyResponse();
  };
  const response = await h.handleChat(request("openai/gpt-4.1"));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, EMPTY_RESPONSE_RETRY_EXHAUSTED);
  assert.equal(calls, 3);
});

test("transient empty output can still recover on its first retry", async () => {
  await seedPrimary();
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1 ? emptyResponse() : h.buildOpenAIResponse("Recovered");
  const response = await h.handleChat(request("openai/gpt-4.1"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "Recovered");
  assert.equal(calls, 2);
});

for (const strategy of ["priority", "round-robin"]) {
  test(`${strategy} combo advances immediately after an exhausted empty-response budget`, async () => {
    const calls: string[] = [];
    const response = await handleComboChat({
      body: { model: "budget-combo", messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: `budget-${strategy}`,
        strategy,
        config: { maxRetries: 5, retryDelayMs: 0, failoverBeforeRetry: false },
        models: ["openai/gpt-4.1", "openai/gpt-4o-mini"],
      },
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return model === "openai/gpt-4.1"
          ? createErrorResult(
              502,
              "Empty output attempt limit reached",
              null,
              EMPTY_RESPONSE_RETRY_EXHAUSTED
            ).response
          : h.buildOpenAIResponse("OK");
      },
      log,
      settings: {},
      allCombos: [],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ["openai/gpt-4.1", "openai/gpt-4o-mini"]);
  });
}

test("separate combo steps for the same provider/model share the empty-output budget", async () => {
  const accounts = [];
  for (let i = 0; i < 5; i++) {
    accounts.push(
      await h.seedConnection("openai", { name: `pinned-${i}`, apiKey: `sk-pinned-${i}` })
    );
  }
  await h.seedConnection("claude", { apiKey: "sk-backup" });
  await h.combosDb.createCombo({
    name: "pinned-empty-fallback",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: [
      ...accounts.map((account, index) => ({
        id: `pinned-step-${index}`,
        kind: "model",
        model: "openai/gpt-4.1",
        connectionId: account.id,
      })),
      { kind: "model", model: "claude/claude-3-5-sonnet-20241022" },
    ],
  });
  let primaryCalls = 0;
  globalThis.fetch = async (_url, init = {}) => {
    const headers = h.toPlainHeaders(init.headers) as Record<string, string>;
    if (headers["x-api-key"] === "sk-backup") return h.buildClaudeResponse("Backup");
    primaryCalls++;
    return emptyResponse();
  };
  const response = await h.handleChat(request("pinned-empty-fallback"));
  assert.equal(response.status, 200);
  assert.equal(primaryCalls, 3, "the fourth and fifth combo steps must not reset the budget");
});

for (const failure of [
  { errorCode: "empty_response_retry_exhausted" },
  { error: "[codex/gpt-5.5] returned an empty response (no usable choices/output)" },
  { error: "Provider returned empty content" },
]) {
  test(`retry budget shares empty-output classification: ${JSON.stringify(failure)}`, () => {
    const budget = new EmptyResponseRetryBudget();
    for (let i = 0; i < 3; i++) {
      assert.equal(budget.recordFailure("codex", "primary", { status: 502, ...failure }), i === 2);
      assert.equal(budget.recordFailure("codex", "backup", { status: 500, ...failure }), false);
    }
    assert.equal(budget.isExhausted("codex", "backup"), false);
  });
}
