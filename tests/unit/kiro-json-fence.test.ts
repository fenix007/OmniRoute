import test from "node:test";
import assert from "node:assert/strict";

const { stripJsonFenceFromSse, kiroPayloadWantsJsonOnly } =
  await import("../../open-sse/executors/kiro/jsonFence.ts");
const { buildKiroPayload } = await import("../../open-sse/translator/request/openai-to-kiro.ts");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sseChunk(content: string): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "kr/claude-haiku-4.5",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

const FINISH_LINE = `data: ${JSON.stringify({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "kr/claude-haiku-4.5",
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
})}\n\n`;

/** Run raw SSE text through the stripper, in the given byte splits. */
async function run(parts: string[]): Promise<string> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });

  const reader = stripJsonFenceFromSse(source).getReader();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

/** The content a client would assemble from the resulting stream. */
function assembledContent(sse: string): string {
  let content = "";
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload === "[DONE]") continue;
    const delta = JSON.parse(payload).choices?.[0]?.delta;
    if (typeof delta?.content === "string") content += delta.content;
  }
  return content;
}

const OBJECT = '{\n  "residual_gap_score": 4,\n  "evidence_kind": "explicit"\n}';

test("a fenced JSON reply is unwrapped into parseable content", async () => {
  const sse = await run([
    sseChunk("```json\n"),
    sseChunk(OBJECT),
    sseChunk("\n```"),
    FINISH_LINE,
    "data: [DONE]\n\n",
  ]);

  const content = assembledContent(sse);
  assert.equal(content, OBJECT);
  assert.deepEqual(JSON.parse(content), { residual_gap_score: 4, evidence_kind: "explicit" });
});

test("the fence survives being split across chunk boundaries", async () => {
  const sse = await run([
    sseChunk("``"),
    sseChunk("`js"),
    sseChunk("on\n{"),
    sseChunk('"a":1}\n`'),
    sseChunk("``"),
    FINISH_LINE,
  ]);

  assert.equal(assembledContent(sse), '{"a":1}');
});

test("a bare fence with no language tag is unwrapped too", async () => {
  const sse = await run([sseChunk('```\n{"a":1}\n```'), FINISH_LINE]);
  assert.equal(assembledContent(sse), '{"a":1}');
});

test("an unfenced reply passes through byte for byte", async () => {
  const sse = await run([sseChunk('{"a":1,\n'), sseChunk('"b":2}'), FINISH_LINE]);
  assert.equal(assembledContent(sse), '{"a":1,\n"b":2}');
});

test("backticks inside a JSON string are not mistaken for a fence", async () => {
  const value = '{"note":"use ``` for code","a":1}';
  const sse = await run([sseChunk(value), FINISH_LINE]);
  assert.equal(assembledContent(sse), value);
});

test("held-back content is released before the finishing chunk", async () => {
  const sse = await run([sseChunk('```json\n{"a":1}\n'), sseChunk("```"), FINISH_LINE]);

  const dataLines = sse.split("\n").filter((l) => l.startsWith("data: "));
  const finishIndex = dataLines.findIndex((l) => JSON.parse(l.slice(6)).choices[0].finish_reason);
  assert.ok(finishIndex >= 0, "finishing chunk must still be present");

  const before = dataLines
    .slice(0, finishIndex)
    .map((l) => JSON.parse(l.slice(6)).choices[0].delta.content ?? "")
    .join("");
  assert.equal(before, '{"a":1}');
});

test("a stream that ends without a finishing chunk still releases its tail", async () => {
  const sse = await run([sseChunk('```json\n{"a":1}\n```')]);
  assert.equal(assembledContent(sse), '{"a":1}');
});

test("tool-call and reasoning deltas are left alone", async () => {
  const toolLine = `data: ${JSON.stringify({
    id: "chatcmpl-1",
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: "```" } }] },
        finish_reason: null,
      },
    ],
  })}\n\n`;
  const reasoningLine = `data: ${JSON.stringify({
    id: "chatcmpl-1",
    choices: [{ index: 0, delta: { reasoning_content: "```thinking" }, finish_reason: null }],
  })}\n\n`;

  const sse = await run([toolLine, reasoningLine, FINISH_LINE]);
  assert.ok(sse.includes('"arguments":"```"'));
  assert.ok(sse.includes('"reasoning_content":"```thinking"'));
});

test("non-data lines and unparseable payloads pass through untouched", async () => {
  const sse = await run([": keepalive\n\n", "data: not-json\n\n", FINISH_LINE]);
  assert.ok(sse.includes(": keepalive"));
  assert.ok(sse.includes("data: not-json"));
});

/**
 * The executor is handed the already-translated Kiro payload, not the OpenAI
 * request, so this decision must be made against real translator output — a
 * check written against `{ response_format }` compiles, passes, and never fires
 * in production.
 */
function payloadFor(responseFormat?: unknown): unknown {
  return buildKiroPayload(
    "claude-haiku-4.5",
    {
      messages: [{ role: "user", content: "Score this candidate." }],
      ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
    },
    false,
    {}
  );
}

test("a translated payload built from a JSON response_format is detected", () => {
  const schema = { type: "object", properties: { a: { type: "integer" } } };
  assert.equal(
    kiroPayloadWantsJsonOnly(payloadFor({ type: "json_schema", json_schema: { schema } })),
    true
  );
  assert.equal(kiroPayloadWantsJsonOnly(payloadFor({ type: "json_object" })), true);
});

test("a translated payload without a JSON contract is not detected", () => {
  for (const format of [undefined, { type: "text" }, { type: "json_schema" }]) {
    assert.equal(kiroPayloadWantsJsonOnly(payloadFor(format)), false, JSON.stringify(format));
  }
});

test("kiroPayloadWantsJsonOnly tolerates malformed payloads", () => {
  for (const value of [null, undefined, {}, { conversationState: {} }, "payload", 42]) {
    assert.equal(kiroPayloadWantsJsonOnly(value), false, JSON.stringify(value));
  }
});
