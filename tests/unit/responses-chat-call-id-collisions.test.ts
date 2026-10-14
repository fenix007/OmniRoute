import "../_setup/isolateDataDir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses/toResponses.ts";
function translate(ids: string[], reverse = false) {
  const outputs = ids.map((id) => ({ role: "tool", tool_call_id: id, content: id }));
  const body = {
    messages: [
      {
        role: "assistant",
        tool_calls: ids.map((id) => ({
          id,
          type: "function",
          function: { name: "lookup", arguments: "{}" },
        })),
      },
      ...(reverse ? outputs.reverse() : outputs),
    ],
  };
  const before = structuredClone(body);
  const result = openaiToOpenAIResponsesRequest("gpt-5.5", body, true);
  assert.deepEqual(body, before);
  return result.input as Array<Record<string, string>>;
}
for (const reverse of [false, true]) {
  test(`long IDs sharing prefix remain distinct and paired (reverse=${reverse})`, () => {
    const ids = ["a".repeat(64) + "X", "a".repeat(64) + "Y"];
    const result = translate(ids, reverse);
    const calls = result.filter((i) => i.type === "function_call");
    assert.notEqual(calls[0].call_id, calls[1].call_id);
    for (let i = 0; i < ids.length; i++)
      assert.equal(result.find((x) => x.output === ids[i])?.call_id, calls[i].call_id);
    assert.deepEqual(translate(ids, reverse), result);
  });
}
test("all legal IDs are reserved before long-ID assignment", () => {
  const long = "a".repeat(65);
  const suffix = createHash("sha256")
    .update(Buffer.from(long, "utf16le"))
    .digest("hex")
    .slice(0, 16);
  const candidate = "a".repeat(47) + "_" + suffix;
  const result = translate([long, candidate]);
  const calls = result.filter((i) => i.type === "function_call");
  assert.equal(calls[1].call_id, candidate);
  assert.deepEqual(translate([long, candidate]), result);
  assert.notEqual(calls[0].call_id, candidate);
});
test("valid IDs stay unchanged; long Unicode has safe byte and character boundaries", () => {
  const ids = [
    "short",
    "a".repeat(64),
    "😀".repeat(32),
    "a" + "😀".repeat(40),
    "界".repeat(64),
    "界".repeat(70),
    "\ud800".repeat(65),
    "\ud801".repeat(65),
  ];
  const result = translate(ids);
  const calls = result.filter((i) => i.type === "function_call");
  for (let i = 0; i < ids.length; i++) {
    if (ids[i].length <= 64) assert.equal(calls[i].call_id, ids[i]);
    else {
      assert.ok(calls[i].call_id.length <= 64);
      assert.ok(Buffer.byteLength(calls[i].call_id) <= 64);
      assert.ok(calls[i].call_id.isWellFormed());
    }
    assert.equal(result.find((x) => x.output === ids[i])?.call_id, calls[i].call_id);
  }
  assert.equal(new Set(calls.map((i) => i.call_id)).size, ids.length);
});

test("Codex HTTP serializes distinct paired Chat IDs and leaves native Responses unchanged", async (t) => {
  const { CodexExecutor } = await import("../../open-sse/executors/codex.ts");
  const { closeDbInstance } = await import("../../src/lib/db/core.ts");
  const sent: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_probe","status":"completed","output":[]}}\n\n',
      { headers: { "content-type": "text/event-stream" } }
    );
  });
  try {
    const executor = new CodexExecutor();
    const ids = ["x".repeat(64) + "A", "x".repeat(64) + "B"];
    const input = translate(ids);
    const response = await executor.execute({
      model: "gpt-5.5",
      body: { input },
      stream: true,
      credentials: { accessToken: "synthetic-test" },
    });
    await response.response.text();
    assert.equal(sent.length, 1);
    const wire = sent[0].input as Array<Record<string, string>>;
    const calls = wire.filter((i) => i.type === "function_call");
    assert.notEqual(calls[0].call_id, calls[1].call_id);
    for (let i = 0; i < ids.length; i++)
      assert.equal(wire.find((x) => x.output === ids[i])?.call_id, calls[i].call_id);
    const native = executor.transformRequest(
      "gpt-5.5",
      {
        _nativeCodexPassthrough: true,
        input: [
          { type: "function_call", name: "lookup", arguments: "{}", call_id: ids[0] },
          { type: "function_call_output", call_id: ids[0], output: "ok" },
        ],
      },
      true,
      {}
    );
    assert.deepEqual(
      (native.input as Array<Record<string, string>>).map((i) => i.call_id),
      [ids[0], ids[0]]
    );
  } finally {
    closeDbInstance();
  }
});

test("legacy function IDs share mapping and trim asymmetry remains unchanged", () => {
  const name = "function_" + "a".repeat(70);
  const result = openaiToOpenAIResponsesRequest(
    "model",
    {
      messages: [
        { role: "assistant", function_call: { name, arguments: "{}" } },
        { role: "function", name, content: "ok" },
      ],
    },
    true
  );
  const input = result.input as Array<Record<string, string>>;
  assert.equal(input[0].call_id, input[1].call_id);
  assert.ok(input[0].call_id.length <= 64);
  const asymmetric = openaiToOpenAIResponsesRequest(
    "model",
    {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: " id", type: "function", function: { name: "lookup", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: " id", content: "orphan" },
      ],
    },
    true
  );
  assert.equal((asymmetric.input as Array<Record<string, string>>)[0].call_id, "id");
  assert.equal((asymmetric.input as unknown[]).length, 1);
});

test("orphan output sharing only a truncated prefix stays orphaned", () => {
  const prefix = "a".repeat(64);
  const result = openaiToOpenAIResponsesRequest(
    "model",
    {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: prefix + "A", type: "function", function: { name: "lookup", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: prefix + "B", content: "unrelated" },
      ],
    },
    true
  );
  assert.equal((result.input as unknown[]).length, 1);
});

test("stateful previous_response_id retains legacy mapping pending replay adaptation", () => {
  const id = "a".repeat(65);
  const result = openaiToOpenAIResponsesRequest(
    "model",
    {
      previous_response_id: "resp_previous",
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id, type: "function", function: { name: "lookup", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: id, content: "ok" },
      ],
    },
    true
  );
  assert.equal(result.previous_response_id, "resp_previous");
  assert.deepEqual(
    (result.input as Array<Record<string, string>>).map((i) => i.call_id),
    [id.slice(0, 64), id.slice(0, 64)]
  );
});
