import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-images-openai-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { handleImageGeneration } = await import("../../open-sse/handlers/imageGeneration.ts");

test.after(() => {
  resetDbInstance();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("handleImageGeneration routes OpenAI-compatible providers and forwards image options", async () => {
  const originalFetch = globalThis.fetch;
  let captured;

  globalThis.fetch = async (url, options = {}) => {
    captured = {
      url: String(url),
      headers: options.headers,
      body: JSON.parse(String(options.body || "{}")),
    };

    return new Response(
      JSON.stringify({
        created: 123,
        data: [{ url: "https://cdn.example.com/image.png" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const result = await handleImageGeneration({
      body: {
        model: "openai/gpt-image-2",
        prompt: "city skyline",
        n: 2,
        size: "1024x1536",
        quality: "hd",
        response_format: "url",
        style: "vivid",
      },
      credentials: { apiKey: "image-key" },
      log: null,
    });

    assert.equal(result.success, true);
    assert.equal(captured.url, "https://api.openai.com/v1/images/generations");
    assert.equal(captured.headers.Authorization, "Bearer image-key");
    assert.deepEqual(captured.body, {
      model: "gpt-image-2",
      prompt: "city skyline",
      n: 2,
      size: "1024x1536",
      quality: "hd",
      response_format: "url",
      style: "vivid",
    });
    assert.equal(result.data.data[0].url, "https://cdn.example.com/image.png");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
