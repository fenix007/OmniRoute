import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "combo-before-output-"));
const { validateResponseQuality, handleComboChat } =
  await import("../../open-sse/services/combo.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const encoder = new TextEncoder();
const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const failure = frame({
  type: "response.failed",
  response: { status: "failed", error: { message: "overloaded" } },
});
const scaffolding = [
  frame({ type: "response.created", response: { status: "in_progress" } }),
  frame({ type: "response.output_item.added", item: { type: "reasoning", summary: [] } }),
  frame({ type: "response.output_item.added", item: { type: "message", content: [] } }),
  frame({ type: "response.content_part.added", part: { type: "output_text", text: "" } }),
];
function response(chunks: string[], error = false) {
  let i = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
        else if (error) controller.error(new Error("upstream interrupted"));
        else controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  );
}
test.after(() => {
  resetDbInstance();
  fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});
for (const tail of [failure, 'event: error\ndata: {"error":{"message":"overloaded"}}\n\n']) {
  test("lifecycle scaffolding followed by error is rejected", async () => {
    const result = await validateResponseQuality(response([...scaffolding, tail]), true, {});
    assert.equal(result.valid, false);
  });
}
test("reader error before actual output is rejected", async () => {
  const result = await validateResponseQuality(response(scaffolding, true), true, {});
  assert.equal(result.valid, false);
});
for (const output of [
  { type: "response.output_text.delta", delta: "partial answer" },
  { type: "response.reasoning_text.delta", delta: "thinking" },
  {
    type: "response.output_item.added",
    item: { type: "function_call", name: "write_file", arguments: "" },
  },
]) {
  test(`does not replay after ${output.type}`, async () => {
    const raw = [...scaffolding, frame(output), failure].join("");
    const result = await validateResponseQuality(response([raw]), true, {});
    assert.equal(result.valid, true);
    assert.equal(await result.clonedResponse!.text(), raw);
  });
}
for (const strategy of ["priority", "round-robin"]) {
  test(`${strategy} falls back on failed SSE before emitting any output`, async () => {
    const calls: string[] = [];
    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: `early-failure-${strategy}`,
        strategy,
        models: ["openai/broken", "openai/healthy"],
        config: { maxRetries: 0, retryDelayMs: 0 },
      },
      handleSingleModel: async (_body: unknown, model: string) => {
        calls.push(model);
        return model.endsWith("broken")
          ? response([...scaffolding, failure])
          : response([frame({ choices: [{ delta: { content: "recovered" } }] })]);
      },
      isModelAvailable: async () => true,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      settings: null,
      allCombos: null,
      relayOptions: null as never,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["openai/broken", "openai/healthy"]);
    const body = await result.text();
    assert.match(body, /recovered/);
    assert.doesNotMatch(body, /response.failed/);
  });
}

for (const strategy of ["priority", "round-robin"]) {
  test(`${strategy} does not retry caller errors`, async () => {
    let calls = 0;
    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: `caller-error-${strategy}`,
        strategy,
        models: ["openai/bad-input", "openai/other"],
        config: { maxRetries: 0 },
      },
      handleSingleModel: async () => {
        calls++;
        return response([
          frame({
            type: "response.failed",
            response: { error: { code: "context_length_exceeded" } },
          }),
        ]);
      },
      isModelAvailable: async () => true,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      settings: null,
      allCombos: null,
      relayOptions: null as never,
    });
    assert.equal(result.status, 400);
    assert.equal(calls, 1);
  });
}

test("AbortError during peek is terminal", async () => {
  const upstream = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new DOMException("Client left", "AbortError"));
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  );
  const result = await validateResponseQuality(upstream, true, {});
  assert.equal(result.valid, false);
  assert.equal(result.terminalResponse?.status, 499);
});

test("oversized ambiguous SSE prefix is forwarded byte for byte", async () => {
  const raw = 'data: {"padding":"' + "x".repeat(1024 * 1024);
  const result = await validateResponseQuality(response([raw]), true, {});
  assert.equal(result.valid, true);
  assert.equal(await result.clonedResponse!.text(), raw);
});
