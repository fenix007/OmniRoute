import test from "node:test";
import assert from "node:assert/strict";
import "../_setup/isolateDataDir.ts";

const { openaiToOpenAIResponsesResponse: translate } =
  await import("../../open-sse/translator/response/openai-responses.ts");
const { initState } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { createSSEStream } = await import("../../open-sse/utils/stream.ts");

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: "synthetic-eof",
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

const deltas = {
  text: { content: "Partial answer" },
  reasoning: { reasoning_content: "Partial reasoning" },
  tool: {
    tool_calls: [
      {
        index: 0,
        id: "call_probe",
        type: "function",
        function: { name: "read", arguments: '{"path":' },
      },
    ],
  },
};

for (const [name, delta] of Object.entries(deltas)) {
  test(`missing terminal after ${name} fails and retains partial output`, () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    translate(chunk(delta), state);
    const events = translate(null, state);
    assert.ok(!events.some((e) => e.event === "response.completed"));
    const failure = events.find((e) => e.event === "response.failed");
    assert.equal(failure?.data.response.status, "failed");
    assert.ok(failure.data.response.output.length > 0);
    assert.equal(state.upstreamError.code, "stream_early_eof");
    assert.deepEqual(translate(null, state), []);
  });
}

for (const reason of ["stop", "tool_calls", "length", "content_filter"]) {
  test(`explicit ${reason} retains the frozen terminal contract with trailing usage`, () => {
    for (const trailingUsage of [false, true]) {
      const state = initState(FORMATS.OPENAI_RESPONSES);
      translate(chunk({ content: "Answer" }), state);
      const events = translate(chunk({}, reason), state);
      if (trailingUsage)
        events.push(
          ...translate({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }, state)
        );
      events.push(...translate(null, state));
      const terminal = events.filter((e) => e.event === "response.completed");
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0].data.response.status, "completed");
      assert.equal(state.upstreamError, undefined);
      if (trailingUsage) assert.equal(terminal[0].data.response.usage.output_tokens, 2);
    }
  });
}

test("usage without a finish reason cannot turn EOF into success", () => {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  translate(chunk(deltas.reasoning), state);
  translate({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }, state);
  const terminal = translate(null, state).find((e) => e.event === "response.failed");
  assert.equal(terminal?.data.response.usage.output_tokens, 2);
});

test("known upstream failure keeps its cause and sanitizes its failure terminal", () => {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  translate(chunk(deltas.text), state);
  state.upstreamError = {
    status: 429,
    code: "rate_limit_exceeded",
    message: "Overloaded /private/server.ts:12\n at private stack",
  };
  const terminal = translate(null, state).find((e) => e.event === "response.failed");
  assert.equal(terminal?.data.response.error.code, "429");
  assert.equal(terminal.data.response.error.message, "Overloaded <path>");
  assert.equal(state.upstreamError.code, "rate_limit_exceeded");
});

for (const [name, delta] of Object.entries(deltas)) {
  test(`pipeline ${name} EOF preserves queued events for a slow reader and records failure once`, async () => {
    const completions: Record<string, unknown>[] = [];
    const failures: Record<string, unknown>[] = [];
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(chunk(delta))}\n\n`);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13));
        controller.close();
      },
    });
    const reader = source
      .pipeThrough(
        createSSEStream({
          mode: "translate",
          targetFormat: FORMATS.OPENAI,
          sourceFormat: FORMATS.OPENAI_RESPONSES,
          provider: "test-provider",
          model: "test-model",
          body: { messages: [{ role: "user", content: "Test" }] },
          onFailure: (value) => {
            failures.push(value);
            return true;
          },
          onComplete: (value) => {
            completions.push(value);
          },
        })
      )
      .getReader();
    // Let flush queue its terminal before the consumer starts reading.
    await new Promise((resolve) => setTimeout(resolve, 20));
    let wire = "";
    const decoder = new TextDecoder();
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      wire += decoder.decode(result.value, { stream: true });
    }
    assert.match(wire, /response\.failed/);
    assert.doesNotMatch(wire, /response\.completed/);
    assert.match(wire, /Partial|call_probe/);
    assert.equal(failures.length, 1);
    assert.equal(completions.length, 1);
    assert.equal(failures[0].status, 502);
    assert.equal(completions[0].status, 502);
    assert.equal(completions[0].errorCode, "stream_early_eof");
    assert.equal(completions[0].interrupted, true);
  });
}

for (const abort of [false, true]) {
  test(`client ${abort ? "abort" : "cancel"} cancels upstream without a success callback`, async () => {
    let cancelled = 0;
    let completed = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(chunk(deltas.text))}\n\n`)
        );
      },
      cancel() {
        cancelled++;
      },
    });
    const signal = new AbortController();
    const reader = source
      .pipeThrough(
        createSSEStream({
          mode: "translate",
          targetFormat: FORMATS.OPENAI,
          sourceFormat: FORMATS.OPENAI_RESPONSES,
          provider: "test-provider",
          model: "test-model",
          body: {},
          onComplete: () => {
            completed++;
          },
        }),
        { signal: signal.signal }
      )
      .getReader();
    assert.equal((await reader.read()).done, false);
    if (abort) {
      signal.abort();
      await assert.rejects(async () => {
        while (!(await reader.read()).done) {
          /* drain buffered deltas */
        }
      });
    } else {
      await reader.cancel("client disconnected");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cancelled, 1);
    assert.equal(completed, 0);
  });
}

async function readPipeline(
  events: unknown[],
  targetFormat = FORMATS.OPENAI,
  options = {},
  tail = ""
) {
  const wire = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + tail;
  const source = new Response(wire).body;
  return new Response(
    source.pipeThrough(
      createSSEStream({
        mode: "translate",
        targetFormat,
        sourceFormat: FORMATS.OPENAI_RESPONSES,
        provider: "test-provider",
        model: "test-model",
        body: {},
        ...options,
      })
    )
  ).text();
}

test("DONE is a terminal with or without a final newline; shared finishReason is not", async () => {
  for (const tail of ["data: [DONE]\n\n", "data: [DONE]"]) {
    const wire = await readPipeline([chunk(deltas.text)], FORMATS.OPENAI, {}, tail);
    assert.match(wire, /response.completed/);
    assert.doesNotMatch(wire, /response.failed/);
  }
  const state = initState(FORMATS.OPENAI_RESPONSES);
  translate(chunk(deltas.text), state);
  state.finishReason = "unrelated-hub-state";
  assert.ok(translate(null, state).some((event) => event.event === "response.failed"));
});

for (const target of [FORMATS.GEMINI, FORMATS.ANTIGRAVITY]) {
  for (const ending of ["stop", "usage-only", "error"]) {
    test(`${target} hub ${ending} preserves the terminal and failure accounting`, async () => {
      const first = {
        candidates: [{ content: { parts: [{ text: "Partial thought", thought: true }] } }],
      };
      const last =
        ending === "stop"
          ? { candidates: [{ finishReason: "STOP", content: { parts: [] } }] }
          : ending === "error"
            ? { error: { code: 503, status: "UNAVAILABLE", message: "Capacity exhausted" } }
            : { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2 } };
      const completions = [];
      const failures = [];
      const wire = await readPipeline([first, last], target, {
        onComplete: (p) => completions.push(p),
        onFailure: (p) => failures.push(p),
      });
      assert.match(wire, /Partial thought/);
      assert.equal(completions.length, 1);
      if (ending === "stop") {
        assert.match(wire, /response.completed/);
        assert.equal(failures.length, 0);
      } else {
        assert.match(wire, /response.failed/);
        assert.doesNotMatch(wire, /response.completed/);
        assert.equal(failures.length, 1);
        assert.equal(completions[0].status, ending === "error" ? 503 : 502);
      }
    });
  }
}

test("Claude hub accepts its explicit stop reason, but rejects text-only EOF", async () => {
  const content = [
    { type: "message_start", message: { id: "synthetic", model: "test-model" } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Partial answer" },
    },
  ];
  assert.match(await readPipeline(content, FORMATS.CLAUDE), /response.failed/);
  // This frozen translator emits its finish chunk on message_delta, before message_stop.
  const finished = [
    ...content,
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  ];
  for (const events of [finished, [...finished, { type: "message_stop" }]]) {
    const wire = await readPipeline(events, FORMATS.CLAUDE);
    assert.match(wire, /response.completed/);
    assert.doesNotMatch(wire, /response.failed/);
  }
});

test("failure terminal emitted before flush remains readable and clears only its pending request", async () => {
  const { register, getResponseTranslator } = await import("../../open-sse/translator/registry.ts");
  const { trackPendingRequest, getPendingRequests } =
    await import("../../src/lib/usage/usageHistory.ts");
  const original = getResponseTranslator(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
  const model = "early-failure-terminal";
  const provider = "test-provider";
  trackPendingRequest(model, provider, "synthetic", true);
  trackPendingRequest(model, provider, "synthetic", true); // Unrelated concurrent request.
  register(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, undefined, (part, state) => {
    if (!part) return [];
    state.upstreamError = {
      status: 503,
      type: "server_error",
      code: "overloaded",
      message: "Capacity exhausted",
    };
    return [
      {
        event: "response.failed",
        data: { type: "response.failed", response: { status: "failed" } },
      },
    ];
  });
  try {
    const wire = await readPipeline([chunk(deltas.text)], FORMATS.OPENAI, {
      model,
      connectionId: "synthetic",
    });
    assert.match(wire, /response.failed/);
    assert.equal(getPendingRequests().byModel[`${model} (${provider})`], 1);
  } finally {
    register(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, undefined, original);
    trackPendingRequest(model, provider, "synthetic", false);
  }
});

test("a translator flush throw cannot bypass known upstream failure accounting", async () => {
  const { register, getResponseTranslator } = await import("../../open-sse/translator/registry.ts");
  const original = getResponseTranslator(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
  const failures = [];
  const completions = [];
  register(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, undefined, (part, state) => {
    if (!part) throw new Error("Synthetic flush fault");
    state.upstreamError = {
      status: 503,
      type: "server_error",
      code: "overloaded",
      message: "Capacity exhausted",
    };
    return [];
  });
  try {
    await assert.rejects(
      readPipeline([chunk(deltas.text)], FORMATS.OPENAI, {
        onFailure: (p) => failures.push(p),
        onComplete: (p) => completions.push(p),
      }),
      /Capacity exhausted/
    );
    assert.equal(failures.length, 1);
    assert.equal(completions.length, 1);
    assert.equal(completions[0].status, 503);
  } finally {
    register(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, undefined, original);
  }
});
