import test from "node:test";
import assert from "node:assert/strict";
import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

const h = await createChatPipelineHarness("responses-eof-accounting");
const { getPendingRequests } = await import("../../src/lib/usage/usageHistory.ts");
test.beforeEach(async () => h.resetStorage());
test.after(async () => h.cleanup());

for (const mode of ["eof", "cancel", "abort"] as const) {
  test(`translated Responses ${mode} clears pending work through the real request pipeline`, async () => {
    await h.seedConnection("openai", { apiKey: "synthetic-only" });
    let cancellations = 0;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ id: "synthetic-eof", object: "chat.completion.chunk", model: "gpt-4o-mini", choices: [{ index: 0, delta: { content: "Partial answer" }, finish_reason: null }] })}\n\n`
              )
            );
            if (mode === "eof") controller.close();
          },
          cancel() {
            cancellations++;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } }
      );
    const abort = new AbortController();
    const base = h.buildRequest({
      url: "http://localhost/v1/responses",
      body: {
        model: "openai/gpt-4o-mini",
        stream: true,
        input: "Continue",
      },
    });
    const result = await h.handleChat(new Request(base, { signal: abort.signal }));
    assert.equal(result.status, 200);
    if (mode === "eof") {
      const wire = await result.text();
      assert.match(wire, /Partial answer/);
      assert.match(wire, /response.failed/);
      assert.doesNotMatch(wire, /response.completed/);
    } else {
      const reader = result.body.getReader();
      assert.equal((await reader.read()).done, false);
      if (mode === "abort") abort.abort();
      else await reader.cancel("client disconnected");
      if (mode === "abort") await reader.cancel().catch(() => {});
      assert.ok(await h.waitFor(() => cancellations === 1, 1500));
    }
    assert.ok(
      await h.waitFor(() => Object.values(getPendingRequests().byModel).every((v) => v === 0), 1500)
    );
  });
}
