import assert from "node:assert/strict";
import test from "node:test";
import { createSSEStream } from "../../open-sse/utils/stream.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

for (const suffix of ["", "\n", "\n\n"]) {
  test(`final Chat usage receipt reaches accounting with suffix ${JSON.stringify(suffix)}`, async () => {
    let receipt: unknown;
    const prefix = `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] })}\n\n`;
    const tail = `data: ${JSON.stringify({ id: "c", choices: [], usage: { prompt_tokens: 37, completion_tokens: 9, total_tokens: 46 } })}${suffix}`;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(prefix));
        controller.enqueue(new TextEncoder().encode(tail));
        controller.close();
      },
    });
    await new Response(
      source.pipeThrough(
        createSSEStream({
          mode: "passthrough",
          sourceFormat: FORMATS.OPENAI,
          provider: "opencode-go",
          model: "m",
          body: { messages: [] },
          onComplete(value) {
            receipt = value.usage;
          },
        })
      )
    ).text();
    assert.equal((receipt as Record<string, number>).prompt_tokens, 37);
    assert.equal((receipt as Record<string, number>).completion_tokens, 9);
  });
}

test("final usage receipt is retained across byte fragmentation and CRLF endings", async () => {
  let usage: unknown;
  const raw = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\r\n\r\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 91, completion_tokens: 4 } })}\r\n`;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of new TextEncoder().encode(raw)) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  await new Response(
    source.pipeThrough(
      createSSEStream({
        mode: "passthrough",
        sourceFormat: FORMATS.OPENAI,
        provider: "opencode-go",
        model: "m",
        onComplete(value) {
          usage = value.usage;
        },
      })
    )
  ).text();
  assert.equal((usage as Record<string, number>).prompt_tokens, 91);
  assert.equal((usage as Record<string, number>).completion_tokens, 4);
});
