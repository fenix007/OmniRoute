import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCodexImageFailure,
  extractImageGenerationCalls,
} from "../../open-sse/handlers/imageGeneration/codex.ts";

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

test("Codex image diagnostics preserve refusal priority and terminal error replacement", () => {
  const failed = event({ type: "response.failed", error: { code: "SERVER_ERROR" } });
  const completed = event({ type: "response.completed", response: { output: [] } });
  assert.deepEqual(classifyCodexImageFailure(failed + completed), {
    kind: "completed_no_image",
    upstreamCode: null,
    sawDone: false,
    sawImageItem: false,
  });
  const image = { type: "image_generation_call", result: "terminal-image" };
  const refusal = { type: "message", content: [{ type: "output_refusal" }] };
  assert.deepEqual(
    classifyCodexImageFailure(
      failed +
        event({
          type: "response.completed",
          response: { output: [image, refusal] },
        }) +
        "data: [DONE]\n"
    ),
    {
      kind: "refusal",
      upstreamCode: null,
      sawDone: true,
      sawImageItem: true,
    }
  );
});

test("Codex image diagnostics sanitize codes, recognize overload, and bound input", () => {
  assert.equal(
    classifyCodexImageFailure(
      event({
        type: "error",
        code: "secret/path",
        message: "Upstream OVERLOADED now",
      })
    ).upstreamCode,
    "overloaded"
  );
  assert.equal(
    classifyCodexImageFailure(
      event({
        type: "response.incomplete",
        response: { incomplete_details: { reason: "CONTENT_FILTER" } },
      })
    ).upstreamCode,
    "content_filter"
  );
  const earlier = event({ type: "error", code: "private_error" }) + " ".repeat(65536);
  assert.deepEqual(classifyCodexImageFailure(earlier), {
    kind: "no_terminal_event",
    upstreamCode: null,
    sawDone: false,
    sawImageItem: false,
  });
});

test("Codex image extraction keeps streamed order and duplicates ahead of terminal snapshots", () => {
  const image = { type: "image_generation_call", result: "streamed", revised_prompt: "revised" };
  const done = event({ type: "response.output_item.done", item: image });
  const terminal = event({
    type: "response.completed",
    response: {
      output: [{ type: "image_generation_call", result: "terminal" }],
    },
  });
  assert.deepEqual(extractImageGenerationCalls(done + terminal + done), [
    { b64: "streamed", revisedPrompt: "revised" },
    { b64: "streamed", revisedPrompt: "revised" },
  ]);
  assert.deepEqual(
    extractImageGenerationCalls(
      event({
        type: "response.output_item.done",
        item: { ...image, result: "" },
      }) + terminal
    ),
    [{ b64: "terminal", revisedPrompt: null }]
  );
});

test("Codex image network errors sanitize paths and stack lines before returning", async () => {
  const { handleCodexImageGeneration } =
    await import("../../open-sse/handlers/imageGeneration/codex.ts");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("connect /private/internal/provider.ts\n    at private-stack");
  };
  try {
    const result = await handleCodexImageGeneration({
      body: { prompt: "test" },
      provider: "codex",
      model: "image-model",
      credentials: { accessToken: "test-token" },
      providerConfig: { baseUrl: "https://example.invalid/responses" },
      startTime: Date.now(),
    });
    assert.equal(result.success, false);
    assert.equal(result.status, 502);
    assert.equal(result.error, "Image provider error: connect <path>");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
