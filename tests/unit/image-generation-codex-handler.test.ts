import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDataDir = mkdtempSync(join(tmpdir(), "omniroute-codex-images-"));
process.env.DATA_DIR = testDataDir;
const { closeDbInstance } = await import("../../src/lib/db/core.ts");
const { handleImageGeneration } = await import("../../open-sse/handlers/imageGeneration.ts");

test.after(() => {
  closeDbInstance();
  rmSync(testDataDir, { recursive: true, force: true });
});
const { extractImageGenerationCalls, classifyCodexImageFailure } =
  await import("../../open-sse/handlers/imageGeneration.ts");

function buildCodexSSE(items) {
  const frames = items.map((item) => JSON.stringify({ type: "response.output_item.done", item }));
  return frames.map((frame) => `event: response.output_item.done\ndata: ${frame}\n`).join("\n");
}

test("extractImageGenerationCalls pulls base64 PNG from image_generation_call output items", () => {
  const sse = buildCodexSSE([
    {
      type: "image_generation_call",
      id: "ig_1",
      status: "completed",
      revised_prompt: "a small kitten",
      result: "aGVsbG8=",
    },
  ]);
  const calls = extractImageGenerationCalls(sse);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].b64, "aGVsbG8=");
  assert.equal(calls[0].revisedPrompt, "a small kitten");
});

test("extractImageGenerationCalls ignores unrelated events and malformed lines", () => {
  const sse = [
    "event: response.in_progress",
    `data: ${JSON.stringify({ type: "response.in_progress" })}`,
    "",
    "data: not-json",
    "",
    "event: response.output_item.done",
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      item: { type: "message", role: "assistant", content: [] },
    })}`,
    "",
    "data: [DONE]",
  ].join("\n");
  assert.deepEqual(extractImageGenerationCalls(sse), []);
});

test("extractImageGenerationCalls accepts a result present only in the completed response", () => {
  const sse = `data: ${JSON.stringify({
    type: "response.completed",
    response: { output: [{ type: "image_generation_call", result: "dGVybWluYWw=" }] },
  })}\n\n`;
  assert.deepEqual(extractImageGenerationCalls(sse), [
    { b64: "dGVybWluYWw=", revisedPrompt: null },
  ]);
  assert.equal(extractImageGenerationCalls(`data: null\n\n${sse}`).length, 1);
});

test("Codex image failure classification uses only bounded SSE metadata", () => {
  const failed = [
    `data: ${JSON.stringify({ type: "response.failed", response: { error: { code: "overloaded", message: "private prompt text" } } })}`,
    "data: [DONE]",
  ].join("\r\n\r\n");
  assert.deepEqual(classifyCodexImageFailure(failed), {
    kind: "response_failed",
    upstreamCode: "overloaded",
    sawDone: true,
    sawImageItem: false,
  });
  assert.deepEqual(
    classifyCodexImageFailure(
      `data: ${JSON.stringify({ type: "error", code: "server_error" })}\n\n`
    ),
    { kind: "response_failed", upstreamCode: "server_error", sawDone: false, sawImageItem: false }
  );
  assert.deepEqual(
    classifyCodexImageFailure(
      `data: ${JSON.stringify({
        type: "response.incomplete",
        response: { incomplete_details: { reason: "content_filter" } },
      })}\n\n`
    ),
    {
      kind: "response_incomplete",
      upstreamCode: "content_filter",
      sawDone: false,
      sawImageItem: false,
    }
  );
  assert.deepEqual(
    classifyCodexImageFailure(
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`
    ),
    { kind: "completed_no_image", upstreamCode: null, sawDone: false, sawImageItem: false }
  );
  assert.deepEqual(classifyCodexImageFailure("data: not-json\n\ndata: null\n\n"), {
    kind: "no_terminal_event",
    upstreamCode: null,
    sawDone: false,
    sawImageItem: false,
  });
  assert.deepEqual(
    classifyCodexImageFailure(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { output: [{ type: "image_generation_call", result: "base64-canary" }] },
      })}\n\n`
    ),
    { kind: "image_in_terminal_only", upstreamCode: null, sawDone: false, sawImageItem: true }
  );
});

test("handleImageGeneration routes codex image requests through /responses with image_generation tool", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options = {}) => {
    captured = {
      url: String(url),
      headers: options.headers,
      body: JSON.parse(String(options.body || "{}")),
    };
    const sse = buildCodexSSE([
      {
        type: "image_generation_call",
        id: "ig_1",
        status: "completed",
        revised_prompt: "happy red kitten",
        result: "a2l0dGVu",
      },
    ]);
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  try {
    const result = await handleImageGeneration({
      body: {
        model: "codex/gpt-5.6-sol",
        prompt: "Draw a happy red kitten",
        response_format: "b64_json",
      },
      credentials: {
        accessToken: "codex-token",
        providerSpecificData: { workspaceId: "acct-123" },
      },
      log: null,
    });

    assert.equal(result.success, true);
    assert.equal(captured.url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(captured.headers.Authorization, "Bearer codex-token");
    assert.equal(captured.headers["chatgpt-account-id"], "acct-123");
    assert.equal(captured.body.model, "gpt-5.6-sol");
    assert.equal(captured.body.stream, true);
    assert.equal(captured.body.store, false);
    assert.deepEqual(captured.body.tools, [{ type: "image_generation", output_format: "png" }]);
    assert.equal(captured.body.input[0].role, "user");
    assert.equal(captured.body.input[0].content[0].text, "Draw a happy red kitten");
    assert.equal(result.data.data[0].b64_json, "a2l0dGVu");
    assert.equal(result.data.data[0].revised_prompt, "happy red kitten");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleImageGeneration (codex) returns a data URL when response_format is not b64_json", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const sse = buildCodexSSE([
      { type: "image_generation_call", id: "ig_2", status: "completed", result: "YWJjZA==" },
    ]);
    return new Response(sse, { status: 200 });
  };

  try {
    const result = await handleImageGeneration({
      body: { model: "cx/gpt-5.6-sol", prompt: "kitten" },
      credentials: { accessToken: "codex-token" },
      log: null,
    });
    assert.equal(result.success, true);
    assert.equal(result.data.data[0].url, "data:image/png;base64,YWJjZA==");
    assert.equal(result.data.data[0].b64_json, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleImageGeneration (codex) fans out n>1 requests in parallel", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let releaseFirst;
  let pending;

  globalThis.fetch = async (_url, options = {}) => {
    const index = calls.length;
    calls.push(JSON.parse(String(options.body || "{}")));
    const sse = buildCodexSSE([
      {
        type: "image_generation_call",
        id: `ig_${index + 1}`,
        status: "completed",
        result: index === 0 ? "Zmlyc3Q=" : "c2Vjb25k",
      },
    ]);

    if (index === 0) {
      return new Promise((resolve) => {
        releaseFirst = () => resolve(new Response(sse, { status: 200 }));
      });
    }

    return new Response(sse, { status: 200 });
  };

  try {
    pending = handleImageGeneration({
      body: {
        model: "codex/gpt-5.6-sol",
        prompt: "kitten",
        n: 2,
        response_format: "b64_json",
      },
      credentials: { accessToken: "codex-token" },
      log: null,
    });

    await Promise.resolve();
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((call) => call.input[0].content[0].text),
      ["kitten", "kitten"]
    );

    releaseFirst();
    const result = await pending;

    assert.equal(result.success, true);
    assert.deepEqual(
      result.data.data.map((item) => item.b64_json),
      ["Zmlyc3Q=", "c2Vjb25k"]
    );
  } finally {
    if (releaseFirst) releaseFirst();
    if (pending) await pending.catch(() => {});
    globalThis.fetch = originalFetch;
  }
});

test("handleImageGeneration (codex) surfaces an error when no image_generation_call is emitted", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const sse = buildCodexSSE([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
    ]);
    return new Response(sse, { status: 200 });
  };

  try {
    const result = await handleImageGeneration({
      body: { model: "codex/gpt-5.6-sol", prompt: "kitten" },
      credentials: { accessToken: "codex-token" },
      log: null,
    });
    assert.equal(result.success, false);
    assert.equal(result.status, 502);
    assert.match(result.error, /image_generation_call/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleImageGeneration (codex) propagates upstream HTTP errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("upstream boom", { status: 403, headers: { "content-type": "text/plain" } });

  try {
    const result = await handleImageGeneration({
      body: { model: "codex/gpt-5.6-sol", prompt: "kitten" },
      credentials: { accessToken: "codex-token" },
      log: null,
    });
    assert.equal(result.success, false);
    assert.equal(result.status, 403);
    assert.match(result.error, /upstream boom/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleImageGeneration (codex) forwards size and maps GPT-Image quality to hosted tool config", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (_url, options = {}) => {
    captured = JSON.parse(String(options.body || "{}"));
    const sse = buildCodexSSE([
      { type: "image_generation_call", id: "ig_1", status: "completed", result: "YWJj" },
    ]);
    return new Response(sse, { status: 200 });
  };

  try {
    await handleImageGeneration({
      body: {
        model: "codex/gpt-5.6-sol",
        prompt: "kitten",
        size: "1024x1792",
        quality: "hd",
      },
      credentials: { accessToken: "codex-token" },
      log: null,
    });
    assert.deepEqual(captured.tools, [
      {
        type: "image_generation",
        output_format: "png",
        size: "1024x1792",
        quality: "high",
      },
    ]);

    await handleImageGeneration({
      body: { model: "codex/gpt-5.6-sol", prompt: "kitten", quality: "standard" },
      credentials: { accessToken: "codex-token" },
      log: null,
    });
    assert.equal(captured.tools[0].quality, "medium");

    await handleImageGeneration({
      body: { model: "codex/gpt-5.6-sol", prompt: "kitten" },
      credentials: { accessToken: "codex-token" },
      log: null,
    });
    assert.deepEqual(captured.tools, [{ type: "image_generation", output_format: "png" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
