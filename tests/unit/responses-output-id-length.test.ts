import test from "node:test";
import assert from "node:assert/strict";

import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.ts";
import { createResponsesApiTransformStream } from "../../open-sse/transformer/responsesTransformer.ts";
import { initState } from "../../open-sse/translator/index.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

type OutputItem = {
  id: string;
  type: string;
  call_id?: string;
  input?: string;
  content?: Array<{ text: string }>;
};
type ResponseEvent = {
  event: string;
  data: {
    item?: OutputItem;
    item_id?: string;
    response?: { id: string; output: OutputItem[] };
  };
};

const incidentResponseId = "resp_0fcdd14430a40b93016af48d62a41887d1ac8822548d09970d";

async function translatorEvents(chunks: unknown[]): Promise<ResponseEvent[]> {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  return [...chunks, null].flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state) || []);
}

async function transformerEvents(chunks: unknown[]): Promise<ResponseEvent[]> {
  const stream = createResponsesApiTransformStream(null, 0);
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  const response = new Response(stream.readable).text();
  for (const chunk of chunks) {
    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  }
  await writer.close();
  return (await response)
    .split("\n\n")
    .filter((frame) => frame.startsWith("event: "))
    .map((frame) => {
      const [event, data] = frame.split("\n");
      return { event: event.slice(7), data: JSON.parse(data.slice(6)) };
    });
}

function assertConsistentItemIds(events: ResponseEvent[]) {
  const added = events.filter((event) => event.event === "response.output_item.added");
  const ids = new Set(added.map((event) => event.data.item.id));
  assert.equal(ids.size, added.length, "each output item must have a distinct ID");
  const done = events.filter((event) => event.event === "response.output_item.done");
  for (const event of events) {
    const responseId = event.data.response?.id;
    const itemId = event.data.item?.id ?? event.data.item_id;
    if (responseId) assert.ok(Array.from(responseId).length <= 64, "response ID exceeds 64");
    if (itemId) {
      assert.ok(Array.from(itemId).length <= 64, `item ID exceeds 64: ${itemId}`);
      assert.ok(ids.has(itemId), "delta/done ID must match an added item");
    }
  }
  const completed = events.find((event) => event.event === "response.completed");
  assert.ok(completed, "stream must complete successfully");
  const response = completed.data.response;
  assert.ok(response);
  assert.deepEqual(
    response.output.map((item) => item.id).sort(),
    done.map((event) => event.data.item.id).sort(),
    "completed snapshot must retain the IDs used throughout the stream"
  );
  return response;
}

for (const [name, collect] of [
  ["translator", translatorEvents],
  ["transformer", transformerEvents],
] as const) {
  test(`${name}: native Responses IDs remain replayable after reasoning and a message`, async () => {
    const events = await collect([
      { id: incidentResponseId, choices: [{ index: 0, delta: { reasoning_content: "Plan" } }] },
      { choices: [{ index: 0, delta: { content: "First" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
    const completed = assertConsistentItemIds(events);
    assert.equal(completed.id, incidentResponseId, "do not duplicate the native resp_ prefix");
    assert.deepEqual(
      completed.output.map((item) => item.id),
      [`rs_${incidentResponseId}_0`, `msg_${incidentResponseId}_1`]
    );
  });

  test(`${name}: long response and tool item IDs are bounded without losing call linkage`, async () => {
    // Both call IDs themselves are valid (64 characters); adding fc_ must not
    // create an invalid item ID. They differ beyond the retained prefix.
    const callIds = [`call_${"a".repeat(58)}x`, `call_${"a".repeat(58)}y`];
    const events = await collect([
      {
        id: `resp_${"b".repeat(1000)}`,
        choices: [{ index: 0, delta: { reasoning_content: "Plan" } }],
      },
      { choices: [{ index: 0, delta: { content: "Answer" } }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: callIds.map((id, index) => ({
                index: index + 3,
                id,
                function: { name: "lookup", arguments: "{" },
              })),
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: callIds.map((_id, index) => ({
                index: index + 3,
                function: { arguments: "}" },
              })),
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);
    const completed = assertConsistentItemIds(events);
    assert.deepEqual(
      completed.output.filter((item) => item.type === "function_call").map((item) => item.call_id),
      callIds,
      "shortening item IDs must preserve tool result call_id linkage"
    );
    assert.ok(completed.output.some((item) => item.type === "reasoning"));
    assert.ok(completed.output.some((item) => item.type === "message"));
  });

  test(`${name}: compliant Chat Completions response and item IDs retain their established shape`, async () => {
    const completed = assertConsistentItemIds(
      await collect([
        {
          id: "chatcmpl-short",
          choices: [{ index: 2, delta: { content: "Answer" }, finish_reason: "stop" }],
        },
      ])
    );
    assert.equal(completed.id, "resp_chatcmpl-short");
    assert.equal(completed.output[0].id, "msg_resp_chatcmpl-short_2");
  });

  test(`${name}: a 64-character response ID stays intact while different message indexes remain distinct`, async () => {
    const responseId = `resp_${"a".repeat(59)}`;
    const completed = assertConsistentItemIds(
      await collect([
        { id: responseId, choices: [{ index: 2, delta: { content: "First" } }] },
        { choices: [{ index: 7, delta: { content: "Second" }, finish_reason: "stop" }] },
      ])
    );
    assert.equal(completed.id, responseId);
    assert.equal(completed.output.length, 2);
    assert.notEqual(completed.output[0].id, completed.output[1].id);
    assert.deepEqual(
      completed.output.map((item) => item.content[0].text),
      ["First", "Second"]
    );
  });
}

test("translator: bounded custom-tool item IDs preserve raw input and call_id", async () => {
  const callId = `call_${"c".repeat(59)}`;
  const rawInput = "*** Begin Patch\n*** End Patch";
  const events = await translatorEvents([
    {
      id: incidentResponseId,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: callId,
                function: { name: "apply_patch", arguments: JSON.stringify({ input: rawInput }) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
  ]);
  const completed = assertConsistentItemIds(events);
  assert.equal(completed.output[0].type, "custom_tool_call");
  assert.equal(completed.output[0].call_id, callId);
  assert.equal(completed.output[0].input, rawInput);
});
