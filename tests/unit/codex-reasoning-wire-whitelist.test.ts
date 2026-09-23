import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexExecutor,
  __setCodexWebSocketTransportForTesting,
} from "../../open-sse/executors/codex.ts";
import {
  DEFAULT_THINKING_CONFIG,
  getThinkingBudgetConfig,
  setThinkingBudgetConfig,
  ThinkingMode,
} from "../../open-sse/services/thinkingBudget.ts";

const originalFetch = globalThis.fetch;
const originalThinking = { ...getThinkingBudgetConfig() };
test.beforeEach(() => setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG));
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  setThinkingBudgetConfig(originalThinking);
  __setCodexWebSocketTransportForTesting(undefined);
});

function transform(body: Record<string, unknown>, model = "gpt-6-astra", endpoint = "/responses") {
  return new CodexExecutor().transformRequest(model, body, false, {
    requestEndpointPath: endpoint,
    providerSpecificData: { requestDefaults: { reasoningEffort: "high" } },
  });
}

for (const native of [false, true]) {
  for (const endpoint of ["/responses", "/responses/compact"]) {
    test(`wire whitelist preserves effort, summary and caller input: native=${native}, ${endpoint}`, () => {
      const body = {
        model: "gpt-6-astra",
        _nativeCodexPassthrough: native,
        input: [],
        reasoning: {
          effort: "low",
          summary: "detailed",
          enabled: true,
          max_tokens: 2048,
          exclude: true,
          future_option: { nested: true },
        },
      };
      const before = structuredClone(body);
      const result = transform(body, body.model, endpoint);
      assert.deepEqual(result.reasoning, { effort: "low", summary: "detailed" });
      assert.deepEqual(body, before);
      assert.equal(result._nativeCodexPassthrough, undefined);
      assert.equal(result.stream, endpoint.endsWith("/compact") ? undefined : true);
      assert.deepEqual(
        result.include,
        endpoint.endsWith("/compact") ? undefined : ["reasoning.encrypted_content"]
      );
    });
  }
}

test("explicit disable wins over connection default, without inventing summary", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.PASSTHROUGH });
  const result = transform({ reasoning: { enabled: false, max_tokens: 2048 } });
  assert.deepEqual(result.reasoning, { effort: "none" });
  assert.equal(result.include, undefined);
});

for (const [model, reasoning, flat, expected] of [
  ["gpt-6-astra-high", { enabled: false, effort: "low" }, "medium", "high"],
  ["gpt-6-astra", { enabled: false, effort: "low" }, "medium", "low"],
  ["gpt-6-astra", { enabled: false }, "medium", "medium"],
  ["gpt-6-astra", { enabled: false }, "none", "none"],
  ["gpt-5.1-mini", { enabled: false, effort: "xhigh" }, undefined, "high"],
  ["gpt-6-astra", { enabled: true, effort: "ultra" }, undefined, "max"],
] as const) {
  test(`real executor effort precedence: ${model} / ${JSON.stringify(reasoning)} / ${flat}`, () => {
    const result = transform({ reasoning, reasoning_effort: flat }, model);
    assert.deepEqual(
      result.reasoning,
      expected === "none" ? { effort: expected } : { effort: expected, summary: "auto" }
    );
    assert.equal(result.reasoning_effort, undefined);
  });
}

test("no resolved effort: strip unknown-only and empty objects before summary injection", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.AUTO });
  for (const reasoning of [{ max_tokens: 2048, exclude: true }, {}, { enabled: true }]) {
    const result = transform({ reasoning });
    assert.equal(result.reasoning, undefined);
    assert.equal(result.include, undefined);
  }
  const result = transform({ reasoning: { summary: "detailed", max_tokens: 2048 } });
  assert.deepEqual(result.reasoning, { summary: "detailed" });
});

test("summary null and explicit includes retain their existing contract", () => {
  const result = transform({
    reasoning: { effort: "high", summary: null, exclude: true },
    include: ["custom", "reasoning.encrypted_content"],
  });
  assert.deepEqual(result.reasoning, { effort: "high", summary: null });
  assert.deepEqual(result.include, ["custom", "reasoning.encrypted_content"]);
});

test("malformed reasoning values retain old passthrough behavior with defaults disabled", () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.AUTO });
  for (const reasoning of [null, "high", false, ["high"]]) {
    assert.deepEqual(transform({ reasoning }).reasoning, reasoning);
  }
});

test("HTTP executor sends only wire reasoning fields for both stream intents", async () => {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const keys = Object.keys(body.reasoning);
    return new Response(JSON.stringify({ id: "resp_mock" }), {
      status: keys.some((key) => !["effort", "summary"].includes(key)) ? 400 : 200,
      headers: { "content-type": "application/json" },
    });
  };
  for (const stream of [false, true]) {
    const result = await new CodexExecutor().execute({
      model: "gpt-6-astra",
      body: {
        model: "gpt-6-astra",
        input: [],
        reasoning: { enabled: false, effort: "high", max_tokens: 1 },
      },
      stream,
      credentials: { accessToken: "test-token", providerSpecificData: { codexTransport: "http" } },
    });
    assert.equal(result.response.status, 200);
    await result.response.text();
  }
  assert.equal(bodies.length, 2);
  for (const body of bodies) assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
});

test("WebSocket response.create uses the same whitelist and closes normally", async () => {
  let sent: Record<string, unknown> | undefined;
  let closed = 0;
  const socket: {
    send(data: string): void;
    close(): void;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: ((event: { message?: string }) => void) | null;
    onclose: (() => void) | null;
  } = {
    send(data) {
      sent = JSON.parse(data);
      queueMicrotask(() =>
        socket.onmessage?.({
          data: JSON.stringify({ type: "response.completed", response: { status: "completed" } }),
        })
      );
    },
    close() {
      closed++;
    },
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  __setCodexWebSocketTransportForTesting(async () => socket);
  const body = { model: "gpt-6-astra", input: [], reasoning: { enabled: false, max_tokens: 2048 } };
  const before = structuredClone(body);
  const result = await new CodexExecutor().execute({
    model: body.model,
    body,
    stream: true,
    credentials: {
      accessToken: "test-token",
      providerSpecificData: { codexTransport: "websocket" },
    },
  });
  const output = await result.response.text();
  assert.equal(sent?.type, "response.create");
  assert.deepEqual(sent?.reasoning, { effort: "none" });
  assert.equal(sent?.stream, undefined);
  assert.equal(closed, 1);
  assert.equal(output.split("event: response.completed").length - 1, 1);
  assert.equal(output.split("data: [DONE]").length - 1, 1);
  assert.deepEqual(body, before);
});
