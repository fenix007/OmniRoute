import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSSEToResponsesOutput } from "../../open-sse/handlers/sseParser.ts";
import { buildStreamSummaryFromEvents } from "../../open-sse/utils/streamPayloadCollector.ts";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-terminal-response-"));
process.env.DATA_DIR = testDataDir;
process.env.APP_LOG_TO_FILE = "false";
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
test.after(() => {
  resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

const textOutput = [
  {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "partial answer" }],
  },
];
const toolOutput = [
  {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "lookup",
    arguments: '{"q":"test"}',
    status: "completed",
  },
];
function envelope(overrides: Record<string, unknown>) {
  return {
    id: "resp_terminal",
    object: "response",
    model: "gpt-5.6-sol",
    status: "completed",
    output: [],
    ...overrides,
  };
}
function toSSE(response: Record<string, unknown>, event = `response.${response.status}`) {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, response })}\n\n`;
}
async function invoke(
  response: Record<string, unknown>,
  sse = true,
  options: { native?: boolean; apiKeyId?: string } = {}
) {
  const originalFetch = globalThis.fetch;
  let successes = 0;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(sse ? toSSE(response) : JSON.stringify(response), {
      headers: { "Content-Type": sse ? "text/event-stream" : "application/json" },
    });
  };
  try {
    const body = {
      model: "codex/gpt-5.6-sol",
      stream: false,
      ...(options.native ? { input: "test" } : { messages: [{ role: "user", content: "test" }] }),
    };
    const result = await handleChatCore({
      body,
      modelInfo: { provider: "codex", model: "gpt-5.6-sol" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      clientRawRequest: {
        endpoint: options.native ? "/v1/responses" : "/v1/chat/completions",
        body,
        headers: new Headers({ accept: "application/json" }),
      },
      apiKeyInfo: options.apiKeyId ? { id: options.apiKeyId } : null,
      onRequestSuccess: async () => {
        successes++;
      },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    return { result, successes, requests, body: await result.response.json() };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("buffered and logged Responses retain the terminal provider error", () => {
  const response = envelope({
    status: "failed",
    error: { code: "server_error", message: "Servers overloaded" },
    incomplete_details: { reason: "upstream_error" },
  });
  const parsed = parseSSEToResponsesOutput(toSSE(response, "response.completed"), "fallback");
  assert.deepEqual(parsed.error, response.error);
  assert.equal(parsed.status, "failed");
  const summary = buildStreamSummaryFromEvents([
    { data: { type: "response.completed", response } },
  ]) as Record<string, unknown>;
  assert.deepEqual(summary.error, response.error);
  assert.deepEqual(summary.incomplete_details, response.incomplete_details);
});

for (const sse of [true, false]) {
  test(`failed ${sse ? "SSE" : "JSON"} preserves upstream cause before reporting success`, async () => {
    const { result, body, successes, requests } = await invoke(
      envelope({
        status: "failed",
        error: {
          code: "server_error",
          message:
            "Servers overloaded /srv/app/private.ts:14\n at internal (/srv/app/internal.ts:1)",
        },
      }),
      sse
    );
    assert.equal(result.success, false);
    assert.equal(result.status, 502);
    assert.equal(body.error.code, "server_error");
    assert.equal(body.error.type, "upstream_response_error");
    assert.match(body.error.message, /Servers overloaded/);
    assert.doesNotMatch(body.error.message, /\/srv\/|at internal/);
    assert.equal(successes, 0);
    assert.equal(requests, 1);
  });
}

test("failed response with usable output must not translate into a successful answer", async () => {
  const { result, successes, body } = await invoke(
    envelope({
      status: "failed",
      output: toolOutput,
      error: { code: "empty_response", message: "Provider returned an empty response" },
    })
  );
  assert.equal(result.success, false);
  assert.equal(body.error.code, "empty_response");
  assert.equal(successes, 0);
  assert.equal(body.choices, undefined);
});

for (const status of ["cancelled", "canceled", "incomplete", "failed"]) {
  test(`${status} without error details is not mislabeled empty success`, async () => {
    const { result, body, successes } = await invoke(envelope({ status }));
    assert.equal(result.success, false);
    assert.equal(body.error.code, `response_${status}`);
    assert.equal(successes, 0);
  });
}

test("completed tool-only output remains a successful tool call", async () => {
  const { result, body, successes } = await invoke(envelope({ output: toolOutput }));
  assert.equal(result.success, true);
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.equal(body.choices[0].message.tool_calls[0].function.name, "lookup");
  assert.equal(successes, 1);
});

test("max-output-token partial text preserves finish_reason length", async () => {
  const { result, body } = await invoke(
    envelope({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: textOutput,
    })
  );
  assert.equal(result.success, true);
  assert.equal(body.choices[0].finish_reason, "length");
  assert.equal(body.choices[0].message.content, "partial answer");
});

test("incomplete tool calls cannot be executed or returned as successful calls", async () => {
  const { result, body, successes } = await invoke(
    envelope({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: toolOutput,
    })
  );
  assert.equal(result.success, false);
  assert.equal(body.error.code, "response_incomplete");
  assert.equal(successes, 0);
});

test("genuinely empty completed response still fails with empty_response", async () => {
  const { result, body, successes } = await invoke(envelope({}));
  assert.equal(successes, 0);
  assert.equal(result.success, false);
  assert.equal(body.error.code, "empty_response");
});

for (const [code, status] of [
  ["rate_limit_exceeded", 429],
  ["invalid_prompt", 400],
  ["content_policy_violation", 400],
  ["context_length_exceeded", 400],
] as const) {
  test(`buffered terminal ${code} preserves upstream HTTP semantics`, async () => {
    const { result, body, successes } = await invoke(
      envelope({ status: "failed", error: { code, message: "Request rejected" } })
    );
    assert.equal(result.status, status);
    assert.equal(body.error.code, code);
    assert.equal(body.error.type, status === 429 ? "rate_limit_error" : "invalid_request_error");
    assert.equal(successes, 0);
  });
}

for (const reason of ["max_output_tokens", "content_filter"]) {
  test(`native Responses preserves useful incomplete ${reason} output`, async () => {
    const { result, body } = await invoke(
      envelope({ status: "incomplete", incomplete_details: { reason }, output: textOutput }),
      true,
      { native: true }
    );
    assert.equal(result.success, true);
    assert.equal(body.status, "incomplete");
    assert.deepEqual(body.incomplete_details, { reason });
    assert.equal(body.output[0].content[0].text, "partial answer");
  });
}

test("native Responses rejects incomplete tool calls and unknown partial outcomes", async () => {
  for (const [reason, output] of [
    ["max_output_tokens", toolOutput],
    ["unknown", textOutput],
  ] as const) {
    const { result, body, successes } = await invoke(
      envelope({ status: "incomplete", incomplete_details: { reason }, output }),
      true,
      { native: true }
    );
    assert.equal(result.status, 502);
    assert.equal(body.error.code, "response_incomplete");
    assert.equal(successes, 0);
  }
});

const { getUsageHistory } = await import("../../src/lib/usage/usageHistory.ts");
const { upsertTokenLimit, getWindowUsage } = await import("../../src/lib/db/tokenLimits.ts");
const { getDailyTotal } = await import("../../src/domain/costRules.ts");
const { calculateCost } = await import("../../src/lib/usage/costCalculator.ts");
const { guardrailRegistry, BaseGuardrail, resetGuardrailsForTests } =
  await import("../../src/lib/guardrails/index.ts");

for (const blocked of [false, true]) {
  test(`${blocked ? "guardrail-blocked" : "failed terminal"} response preserves metering without success`, async () => {
    const apiKeyId = blocked ? "meter-blocked" : "meter-failed";
    const limit = upsertTokenLimit({ apiKeyId, scopeType: "global", tokenLimit: 1000000 });
    if (blocked) {
      class BlockOutput extends BaseGuardrail {
        async postCall() {
          return { block: true, message: "Blocked for test" };
        }
      }
      guardrailRegistry.register(new BlockOutput("test-output-block"));
    }
    const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120 };
    try {
      const { result, successes } = await invoke(
        envelope({
          usage,
          status: blocked ? "completed" : "failed",
          output: blocked ? textOutput : [],
          ...(blocked ? {} : { error: { code: "server_error", message: "Provider failure" } }),
        }),
        true,
        { apiKeyId }
      );
      assert.equal(result.status, blocked ? 400 : 502);
      assert.equal(successes, 0);
      let rows = [];
      for (let i = 0; i < 100; i++) {
        rows = (await getUsageHistory({ provider: "codex" })).filter(
          (row) => row.apiKeyId === apiKeyId
        );
        if (rows.length) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(rows.length, 1, "one failure metering record, no false success or duplicate");
      assert.equal(rows[0].success, false);
      assert.equal(rows[0].status, String(blocked ? 400 : 502));
      assert.equal(rows[0].tokens.input, 100);
      assert.equal(rows[0].tokens.output, 20);
      assert.equal(
        getWindowUsage(limit),
        120,
        "token-limit counter includes spent tokens exactly once"
      );
      const cost = await calculateCost("codex", "gpt-5.6-sol", usage);
      assert.ok(cost > 0, "fixture uses a priced model");
      assert.equal(
        getDailyTotal(apiKeyId),
        cost,
        "failed delivery still accounts for provider cost once"
      );
    } finally {
      resetGuardrailsForTests();
    }
  });
}
