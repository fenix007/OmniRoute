import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-measured-ttft-"));
process.env.DATA_DIR = testDataDir;
process.env.APP_LOG_TO_FILE = "false";
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const core = await import("../../src/lib/db/core.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function event(type: string, data: Record<string, unknown>) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

const RESPONSE = {
  id: "resp_ttft",
  object: "response",
  model: "gpt-5.6-sol",
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      content: [{ type: "output_text", text: "OK" }],
    },
  ],
  usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
};

/** Handshake at once, first text at ~300 ms, completion at ~700 ms. */
function slowCodexStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(event("response.created", { response: { ...RESPONSE, output: [] } }))
      );
      await sleep(300);
      controller.enqueue(
        encoder.encode(
          event("response.output_text.delta", { item_id: "msg_1", output_index: 0, delta: "OK" })
        )
      );
      await sleep(400);
      controller.enqueue(encoder.encode(event("response.completed", { response: RESPONSE })));
      controller.close();
    },
  });
}

async function lastUsageRow(connectionId: string) {
  for (let i = 0; i < 50; i++) {
    const row = core
      .getDbInstance()
      .prepare(
        "SELECT latency_ms, ttft_ms FROM usage_history WHERE connection_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(connectionId) as { latency_ms: number; ttft_ms: number | null } | undefined;
    if (row) return row;
    await sleep(20);
  }
  throw new Error("usage row was not written");
}

for (const clientStream of [true, false]) {
  test(`Codex ${clientStream ? "stream" : "JSON"} usage stores the measured first-output time`, async () => {
    const connectionId = `conn-ttft-${clientStream ? "stream" : "json"}`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(slowCodexStream(), { headers: { "Content-Type": "text/event-stream" } });
    try {
      const body = {
        model: "codex/gpt-5.6-sol",
        stream: clientStream,
        messages: [{ role: "user", content: "Reply OK" }],
      };
      const result = await handleChatCore({
        body,
        modelInfo: { provider: "codex", model: "gpt-5.6-sol" },
        credentials: { accessToken: "codex-token", connectionId, providerSpecificData: {} },
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body,
          headers: new Headers({
            accept: clientStream ? "text/event-stream" : "application/json",
          }),
        },
        apiKeyInfo: null,
        log: { debug() {}, info() {}, warn() {}, error() {} },
      });
      await result.response.text();

      const row = await lastUsageRow(connectionId);
      assert.ok(row.ttft_ms !== null, "Codex TTFT must be measured");
      assert.ok(row.ttft_ms >= 250, `ttft=${row.ttft_ms}`);
      assert.ok(
        row.ttft_ms <= row.latency_ms - 250,
        `ttft=${row.ttft_ms} latency=${row.latency_ms}`
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
