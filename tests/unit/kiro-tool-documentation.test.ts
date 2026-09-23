import "../_setup/isolateDataDir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { v5 as uuidv5 } from "uuid";
import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro.ts";
import { kiroPayloadWantsJsonOnly } from "../../open-sse/executors/kiro/jsonFence.ts";
import { KiroExecutor } from "../../open-sse/executors/kiro.ts";

const MODEL = "claude-sonnet-4.5";
const DOCS = "long-tool-description-".repeat(600);
const HEADING = "# Tool Documentation\n\n";
const NAMESPACE = "34f7193f-561d-4050-bc84-9547d953d6bf";
const tools = [
  {
    type: "function",
    function: {
      name: "long_tool",
      description: DOCS,
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: [],
        additionalProperties: false,
      },
    },
  },
];

function build(messages, stream = true, extra = {}, credentials = {}) {
  return buildKiroPayload(MODEL, { messages, tools, ...extra }, stream, credentials);
}

function userTurns(payload) {
  const state = payload.conversationState;
  return [...state.history, state.currentMessage]
    .filter((turn) => turn.userInputMessage)
    .map((turn) => turn.userInputMessage);
}

function assertDocumentation(payload, carrierIndex = 0) {
  const users = userTurns(payload);
  assert.equal(users.filter((turn) => turn.content.includes(HEADING)).length, 1);
  assert.ok(users[carrierIndex].content.includes(`## Tool: long_tool\n\n${DOCS}`));
  assert.equal(
    users
      .map((turn) => turn.content)
      .join("\n")
      .split(DOCS).length - 1,
    1
  );
  assert.ok(!JSON.stringify(payload).includes('"_toolDocs"'));
  const current = payload.conversationState.currentMessage.userInputMessage;
  assert.equal(
    current.userInputMessageContext.tools[0].toolSpecification.description,
    "[Full documentation in system prompt under '## Tool: long_tool']"
  );
  assert.deepEqual(current.userInputMessageContext.tools[0].toolSpecification.inputSchema.json, {
    type: "object",
    properties: { path: { type: "string" } },
  });
  for (const turn of payload.conversationState.history) {
    assert.equal(turn.userInputMessage?.userInputMessageContext?.tools, undefined);
  }
}

for (const stream of [false, true]) {
  test(`Kiro docs stay on the original turn as history grows (stream=${stream})`, () => {
    const messages = [{ role: "user", content: "original question" }];
    for (let turn = 0; turn < 4; turn++) {
      const original = structuredClone(messages);
      const result = build(messages, stream);
      assertDocumentation(result);
      assert.deepEqual(messages, original);
      if (turn > 0) {
        assert.ok(!result.conversationState.currentMessage.userInputMessage.content.includes(DOCS));
        assert.equal(
          result.conversationState.conversationId,
          uuidv5("original question", NAMESPACE),
          "relocation must not replace the frozen history-based identity seed"
        );
      }
      messages.push({ role: "assistant", content: "answer" }, { role: "user", content: "next" });
    }
  });

  test(`Kiro docs survive an assistant-ending conversation (stream=${stream})`, () => {
    const result = build(
      [
        { role: "user", content: "original" },
        { role: "assistant", content: "answer" },
      ],
      stream
    );
    assertDocumentation(result);
    assert.match(result.conversationState.currentMessage.userInputMessage.content, /\n\n\.\.\.$/);
    assert.equal(result.conversationState.conversationId, uuidv5("original", NAMESPACE));
  });

  test(`Kiro assistant-only fallback relocates docs without changing identity (stream=${stream})`, (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-23T00:00:00Z") });
    const messages = [{ role: "assistant", content: "previous answer" }];
    const result = build(messages, stream, { response_format: { type: "json_object" } });
    const withoutDocs = build(messages, stream, {
      tools: [],
      response_format: { type: "json_object" },
    });
    assertDocumentation(result, 1);
    assert.equal(
      result.conversationState.conversationId,
      withoutDocs.conversationState.conversationId
    );
    assert.equal(userTurns(result)[0].content, "(empty)");
    assert.equal(kiroPayloadWantsJsonOnly(result), true);
    assert.ok(
      result.conversationState.currentMessage.userInputMessage.content.endsWith(
        "</system-reminder>"
      )
    );
  });

  test(`Kiro empty-history fallback relocates docs (stream=${stream})`, () => {
    assertDocumentation(build([], stream));
  });

  test(`Kiro assistant-first history keeps docs off the synthetic turn (stream=${stream})`, () => {
    const messages = [
      { role: "assistant", content: "prefill" },
      { role: "user", content: "real question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "next" },
    ];
    const result = build(messages, stream);
    assertDocumentation(result, 1);
    assert.equal(userTurns(result)[0].content, "(empty)");
    assert.equal(result.conversationState.conversationId, uuidv5("real question", NAMESPACE));
  });

  test(`Kiro docs preserve system text, images, JSON marker and pre-compression seed (stream=${stream})`, () => {
    const messages = [
      { role: "system", content: "follow the rules" },
      {
        role: "user",
        content: [
          { type: "text", text: "image question" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
      { role: "assistant", content: "answer" },
      { role: "user", content: "return JSON" },
    ];
    const original = structuredClone(messages);
    const result = build(
      messages,
      stream,
      { response_format: { type: "json_object" } },
      {
        _preCompressionBody: { messages: [{ role: "user", content: "uncompressed seed" }] },
        providerSpecificData: { profileArn: "arn:aws:example" },
      }
    );
    assertDocumentation(result);
    assert.match(
      userTurns(result)[0].content,
      /<system-reminder>\nfollow the rules\n<\/system-reminder>\n\nimage question/
    );
    assert.deepEqual(userTurns(result)[0].images, [{ format: "png", source: { bytes: "AAAA" } }]);
    assert.equal(result.conversationState.conversationId, uuidv5("uncompressed seed", NAMESPACE));
    assert.equal(result.profileArn, "arn:aws:example");
    assert.equal(kiroPayloadWantsJsonOnly(result), true);
    assert.ok(
      result.conversationState.currentMessage.userInputMessage.content.endsWith(
        "</system-reminder>"
      )
    );
    assert.deepEqual(messages, original);
  });
}

test("Kiro relocation preserves parallel tool results and interleaved assistant prose", () => {
  const messages = [
    { role: "user", content: "run both" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "a", function: { name: "long_tool", arguments: "{}" } },
        { id: "b", function: { name: "long_tool", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "a", content: "first result" },
    { role: "assistant", content: "interleaved prose" },
    { role: "tool", tool_call_id: "b", content: "second result" },
    { role: "user", content: "summarize" },
  ];
  const result = build(messages);
  assertDocumentation(result);
  const history = result.conversationState.history;
  const batchIndex = history.findIndex(
    (turn) => turn.userInputMessage?.userInputMessageContext?.toolResults
  );
  assert.ok(batchIndex >= 0);
  assert.deepEqual(
    history[batchIndex].userInputMessage.userInputMessageContext.toolResults.map(
      (r) => r.toolUseId
    ),
    ["a", "b"]
  );
  assert.equal(history[batchIndex + 1].assistantResponseMessage.content, "interleaved prose");
  assert.match(result.conversationState.currentMessage.userInputMessage.content, /summarize$/);
});

test("Kiro tool descriptions respect the 10000-character boundary and preserve schema inputs", () => {
  for (const messages of [
    [{ role: "user", content: "hello" }],
    [{ role: "assistant", content: "answer" }],
  ]) {
    const inventory = [9999, 10000, 10001].map((size) => ({
      name: `tool_${size}`,
      description: "d".repeat(size),
      input_schema: { type: "object", properties: {} },
    }));
    const original = structuredClone(inventory);
    const result = build(messages, true, { tools: inventory });
    const specs =
      result.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools;
    assert.equal(specs[0].toolSpecification.description.length, 9999);
    assert.equal(specs[1].toolSpecification.description.length, 10000);
    assert.ok(specs[2].toolSpecification.description.length < 10000);
    const content = userTurns(result)
      .map((turn) => turn.content)
      .join("\n");
    assert.ok(content.includes("## Tool: tool_10001\n\n" + "d".repeat(10001)));
    assert.ok(!content.includes("## Tool: tool_10000"));
    assert.ok(!content.includes("## Tool: tool_9999"));
    assert.deepEqual(inventory, original);
  }
});

test("Kiro single-user long-doc identity retains its existing seed", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-23T00:00:00Z") });
  const result = build([{ role: "user", content: "hello" }]);
  const content = `${HEADING}## Tool: long_tool\n\n${DOCS}\n\n---\n\n[Context: Current time is 2026-09-23T00:00:00.000Z]\n\nhello`;
  assert.equal(result.conversationState.currentMessage.userInputMessage.content, content);
  assert.equal(
    result.conversationState.conversationId,
    uuidv5(content.substring(0, 4000), NAMESPACE)
  );
});

test("Kiro empty image carrier stays excluded from conversation identity", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-23T00:00:00Z") });
  const messages = [
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
    },
    { role: "assistant", content: "seen" },
    { role: "user", content: "next" },
  ];
  const result = build(messages);
  const unchangedSeed = build(messages, true, { tools: [] }).conversationState.conversationId;
  assertDocumentation(result);
  assert.equal(result.conversationState.conversationId, unchangedSeed);
  assert.deepEqual(userTurns(result)[0].images, [{ format: "png", source: { bytes: "AAAA" } }]);
});

test("Kiro empty tool-result carrier stays excluded from conversation identity", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-23T00:00:00Z") });
  const messages = [
    {
      role: "assistant",
      tool_calls: [{ id: "a", function: { name: "long_tool", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "a", content: "tool output" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "next" },
  ];
  const result = build(messages);
  const unchangedSeed = build(messages, true, { tools: [] }).conversationState.conversationId;
  assertDocumentation(result, 1);
  assert.equal(result.conversationState.conversationId, unchangedSeed);
  assert.equal(userTurns(result)[1].userInputMessageContext.toolResults[0].toolUseId, "a");
});

test("Kiro mixed catalog relocates multiple docs once and preserves short descriptions", () => {
  const inventory = [
    ...tools,
    { name: "second_tool", description: "second-doc-".repeat(1000) },
    { name: "short_tool", description: "small" },
    { name: "blank_tool", description: "   " },
  ];
  const original = structuredClone(inventory);
  for (const messages of [
    [{ role: "user", content: "hi" }],
    [{ role: "assistant", content: "answer" }],
  ]) {
    const result = build(messages, true, { tools: inventory });
    const users = userTurns(result);
    const content = users.map((turn) => turn.content).join("\n");
    const specs = users.at(-1).userInputMessageContext.tools;
    assert.equal(content.split(HEADING).length - 1, 1);
    assert.equal(content.split(DOCS).length - 1, 1);
    assert.equal(content.split("second-doc-".repeat(1000)).length - 1, 1);
    assert.ok(!content.includes("## Tool: short_tool"));
    assert.equal(specs[2].toolSpecification.description, "small");
    assert.equal(specs[3].toolSpecification.description, "Tool: blank_tool");
  }
  assert.deepEqual(inventory, original);
});

for (const stream of [false, true]) {
  test(`Kiro execute sends relocated docs and preserves the upstream error (stream=${stream})`, async (t) => {
    const body = build(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "next" },
      ],
      stream
    );
    const abort = new AbortController();
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      requests++;
      assert.equal(init.signal, abort.signal);
      const sent = JSON.parse(init.body);
      assertDocumentation(sent);
      assert.deepEqual(sent, body);
      return new Response("upstream unavailable", { status: 503 });
    });
    const result = await new KiroExecutor().execute({
      model: MODEL,
      body,
      stream,
      credentials: { accessToken: "test-token" },
      signal: abort.signal,
    });
    assert.equal(requests, 1);
    assert.equal(result.response.status, 503);
    assert.equal(await result.response.text(), "upstream unavailable");
  });
}
