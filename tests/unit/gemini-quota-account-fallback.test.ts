import test from "node:test";
import assert from "node:assert/strict";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("gemini-quota-account-fallback");
const originalMaxAttempts = harness.BaseExecutor.RETRY_CONFIG.maxAttempts;

test.beforeEach(async () => {
  await harness.resetStorage();
  harness.BaseExecutor.RETRY_CONFIG.delayMs = 0;
  harness.BaseExecutor.RETRY_CONFIG.maxAttempts = 0;
  await harness.settingsDb.updateSettings({ requestRetry: 0 });
});
test.after(async () => {
  harness.BaseExecutor.RETRY_CONFIG.maxAttempts = originalMaxAttempts;
  await harness.cleanup();
});

function quotaResponse() {
  return new Response(
    JSON.stringify({
      error: {
        code: 429,
        message: "Quota exceeded for Generate Content API requests per minute",
        status: "RESOURCE_EXHAUSTED",
      },
    }),
    { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" } }
  );
}

for (const stream of [false, true]) {
  test(`Gemini stream=${stream} rotates after numeric quota error and returns a complete answer`, async () => {
    await harness.seedConnection("gemini", {
      name: "quota",
      apiKey: "gemini-quota-key",
      priority: 1,
    });
    await harness.seedConnection("gemini", {
      name: "healthy",
      apiKey: "gemini-healthy-key",
      priority: 2,
    });
    const keys: string[] = [];
    globalThis.fetch = async (url, init = {}) => {
      assert.match(String(url), /generativelanguage\.googleapis\.com/);
      keys.push(new Headers(init.headers).get("x-goog-api-key") || "");
      if (keys.length === 1) return quotaResponse();
      const chunk = {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "GEMINI_RECOVERED" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
      };
      return new Response(stream ? `data: ${JSON.stringify(chunk)}\n\n` : JSON.stringify(chunk), {
        headers: { "Content-Type": stream ? "text/event-stream" : "application/json" },
      });
    };
    const response = await harness.handleChat(
      harness.buildRequest({
        body: {
          model: "gemini/gemini-3.5-flash",
          stream,
          messages: [{ role: "user", content: "hello" }],
        },
      })
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /GEMINI_RECOVERED/);
    assert.deepEqual(keys, ["gemini-quota-key", "gemini-healthy-key"]);
    if (stream) assert.match(body, /data: \[DONE\]/);
    else assert.equal(JSON.parse(body).choices[0].message.content, "GEMINI_RECOVERED");
  });

  test(`Gemini stream=${stream} returns a structured quota error when every account is exhausted`, async () => {
    await harness.seedConnection("gemini", {
      name: "quota-a",
      apiKey: "gemini-quota-a",
      priority: 1,
    });
    await harness.seedConnection("gemini", {
      name: "quota-b",
      apiKey: "gemini-quota-b",
      priority: 2,
    });
    let calls = 0;
    globalThis.fetch = async (url) => {
      assert.match(String(url), /generativelanguage\.googleapis\.com/);
      calls++;
      return quotaResponse();
    };
    const response = await harness.handleChat(
      harness.buildRequest({
        body: {
          model: "gemini/gemini-3.5-flash",
          stream,
          messages: [{ role: "user", content: "hello" }],
        },
      })
    );
    assert.equal(response.status, 429);
    assert.match(response.headers.get("Content-Type") || "", /application\/json/);
    assert.ok(response.headers.get("Retry-After"));
    assert.ok((await response.json()).error.message);
    assert.equal(calls, 2);
  });
}
