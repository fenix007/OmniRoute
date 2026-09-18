import test from "node:test";
import assert from "node:assert/strict";

const { handleAudioSpeech } = await import("../../open-sse/handlers/audioSpeech.ts");

test("handleAudioSpeech proxies OpenAI-compatible providers with defaults", async () => {
  const originalFetch = globalThis.fetch;
  let captured;

  globalThis.fetch = async (url, options = {}) => {
    captured = {
      url: String(url),
      headers: options.headers,
      body: JSON.parse(String(options.body || "{}")),
    };

    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "audio/opus" },
    });
  };

  try {
    const response = await handleAudioSpeech({
      body: {
        model: "openai/tts-1",
        input: "hello world",
      },
      credentials: { apiKey: "openai-key" },
    });

    assert.equal(captured.url, "https://api.openai.com/v1/audio/speech");
    assert.equal(captured.headers.Authorization, "Bearer openai-key");
    assert.deepEqual(captured.body, {
      model: "tts-1",
      input: "hello world",
      voice: "alloy",
      response_format: "mp3",
      speed: 1,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/opus");
    assert.match(response.headers.get("access-control-allow-methods") || "", /OPTIONS/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
