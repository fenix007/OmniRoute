import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-success-timing-"));
process.env.DATA_DIR = dataDir;
process.env.APP_LOG_TO_FILE = "false";
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
test.after(() => {
  resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
const encoder = new TextEncoder();
const frame = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

for (const failed of [true, false]) {
  test(`account success is deferred until stream completion (${failed ? "failure" : "success"})`, async () => {
    const originalFetch = globalThis.fetch;
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    let successes = 0;
    let fetched!: () => void;
    const ready = new Promise<void>((resolve) => {
      fetched = resolve;
    });
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            upstream = controller;
            fetched();
            controller.enqueue(
              frame({ type: "response.created", response: { id: "r", status: "in_progress" } })
            );
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } }
      );
    try {
      const body = { model: "codex/gpt-5.6-sol", stream: true, input: "test" };
      const resultPromise = handleChatCore({
        body,
        modelInfo: { provider: "codex", model: "gpt-5.6-sol" },
        skipUpstreamRetry: true,
        credentials: { apiKey: "test-key", providerSpecificData: {} },
        clientRawRequest: { endpoint: "/v1/responses", body, headers: new Headers() },
        onRequestSuccess: async () => {
          successes++;
        },
        log: { debug() {}, info() {}, warn() {}, error() {} },
      });
      // Allow readiness to inspect the prelude without waiting for completion.
      await ready;
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(successes, 0, "HTTP 200 and metadata are insufficient");
      if (failed)
        upstream.enqueue(
          frame({
            type: "response.failed",
            response: {
              status: "failed",
              error: { code: "server_error", message: "Servers overloaded" },
            },
          })
        );
      else {
        upstream.enqueue(frame({ type: "response.output_text.delta", delta: "answer" }));
        upstream.enqueue(
          frame({
            type: "response.completed",
            response: {
              id: "r",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "answer" }],
                },
              ],
            },
          })
        );
      }
      upstream.close();
      const result = await resultPromise;
      await result.response.text().catch(() => "interrupted");
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(successes, failed ? 0 : 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
