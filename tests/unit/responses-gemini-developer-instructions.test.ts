import test from "node:test";
import assert from "node:assert/strict";

const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { ANTIGRAVITY_DEFAULT_SYSTEM } = await import("../../open-sse/config/constants.ts");

function bodyWithInstructions() {
  return {
    instructions: "ORDER_TOP",
    input: [
      { type: "message", role: "developer", content: "ORDER_DEVELOPER_FIRST" },
      { type: "message", role: "user", content: "USER_CONTEXT" },
      {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: "ORDER_SYSTEM" }],
      },
      { type: "message", role: "assistant", content: "ASSISTANT_HISTORY" },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "ORDER_DEVELOPER_LAST" }],
      },
      { type: "message", role: "user", content: "USER_QUESTION" },
    ],
    tools: [
      {
        type: "function",
        name: "lookup",
        description: "Look up a value",
        parameters: { type: "object", properties: { key: { type: "string" } } },
      },
    ],
  };
}

function translate(body, source, target, stream) {
  const result = translateRequest(
    source,
    target,
    "gemini-2.5-flash",
    body,
    stream,
    { projectId: "test-project" },
    target === FORMATS.ANTIGRAVITY ? "antigravity" : "gemini"
  );
  return target === FORMATS.ANTIGRAVITY ? result.request : result;
}

for (const target of [FORMATS.GEMINI, FORMATS.ANTIGRAVITY]) {
  for (const stream of [false, true]) {
    test(`Responses -> ${target}, stream=${stream}: retain instructions in order and input`, () => {
      const body = bodyWithInstructions();
      const original = structuredClone(body);
      const wire = translate(body, FORMATS.OPENAI_RESPONSES, target, stream);
      const parts = wire.systemInstruction.parts;
      const instructions = parts
        .map((part) => part.text)
        .filter((text) => text.startsWith("ORDER_"));
      assert.deepEqual(instructions, [
        "ORDER_TOP",
        "ORDER_DEVELOPER_FIRST",
        "ORDER_SYSTEM",
        "ORDER_DEVELOPER_LAST",
      ]);
      assert.deepEqual(JSON.stringify(wire).match(/ORDER_[A-Z_]+/g), instructions);
      assert.deepEqual(
        wire.contents.map((content) => ({ role: content.role, text: content.parts[0].text })),
        [
          { role: "user", text: "USER_CONTEXT" },
          { role: "model", text: "ASSISTANT_HISTORY" },
          { role: "user", text: "USER_QUESTION" },
        ]
      );
      assert.equal(wire.tools[0].functionDeclarations[0].name, "lookup");
      assert.deepEqual(wire.tools[0].functionDeclarations[0].parameters, {
        type: "object",
        properties: { key: { type: "string" } },
      });
      if (target === FORMATS.ANTIGRAVITY) {
        assert.equal(parts[0].text, ANTIGRAVITY_DEFAULT_SYSTEM);
      }
      assert.deepEqual(body, original);
    });

    test(`Responses -> ${target}, stream=${stream}: string input retains top-level instructions`, () => {
      const wire = translate(
        { instructions: "ORDER_TOP", input: "USER_QUESTION" },
        FORMATS.OPENAI_RESPONSES,
        target,
        stream
      );
      assert.equal(wire.systemInstruction.parts.at(-1).text, "ORDER_TOP");
      assert.equal(wire.contents[0].parts[0].text, "USER_QUESTION");
    });

    test(`Chat -> ${target}, stream=${stream}: existing developer normalization is unchanged`, () => {
      const body = {
        messages: [
          { role: "system", content: "ORDER_TOP" },
          { role: "developer", content: "ORDER_DEVELOPER_FIRST" },
          { role: "user", content: "USER_QUESTION" },
        ],
      };
      const original = structuredClone(body);
      const wire = translate(body, FORMATS.OPENAI, target, stream);
      assert.deepEqual(JSON.stringify(wire).match(/ORDER_[A-Z_]+/g), [
        "ORDER_TOP",
        "ORDER_DEVELOPER_FIRST",
      ]);
      assert.deepEqual(body, original);
    });

    test(`Responses -> ${target}, stream=${stream}: tool history survives instruction normalization`, () => {
      const body = bodyWithInstructions();
      const history = [
        ...body.input,
        { type: "function_call", call_id: "call_lookup", name: "lookup", arguments: '{"key":"x"}' },
        { type: "function_call_output", call_id: "call_lookup", output: "TOOL_RESULT" },
      ];
      const input = { ...body, input: history };
      const original = structuredClone(input);
      const control = {
        ...input,
        input: input.input.map((item) =>
          "role" in item && item.role === "developer" ? { ...item, role: "system" } : item
        ),
      };
      const wire = translate(input, FORMATS.OPENAI_RESPONSES, target, stream);
      const expected = translate(control, FORMATS.OPENAI_RESPONSES, target, stream);
      assert.deepEqual(wire.contents, expected.contents);
      assert.deepEqual(wire.tools, expected.tools);
      assert.ok(JSON.stringify(wire.contents).includes("TOOL_RESULT"));
      assert.deepEqual(input, original);
    });
  }
}

test("native Responses keeps developer roles and instructions", () => {
  const body = bodyWithInstructions();
  const original = structuredClone(body);
  const result = translateRequest(
    FORMATS.OPENAI_RESPONSES,
    FORMATS.OPENAI_RESPONSES,
    "gpt-6.1-sol",
    body,
    true,
    null,
    "codex"
  );
  assert.deepEqual(result, original);
  assert.deepEqual(body, original);
});

test("Responses -> OpenAI retains the frozen developer-to-system cleanup", () => {
  const result = translateRequest(
    FORMATS.OPENAI_RESPONSES,
    FORMATS.OPENAI,
    "gpt-6.1-sol",
    bodyWithInstructions(),
    false,
    null,
    "openai",
    null,
    { preserveDeveloperRole: true }
  );
  assert.equal(result.messages.filter((message) => message.role === "system").length, 4);
  assert.deepEqual(JSON.stringify(result).match(/ORDER_[A-Z_]+/g), [
    "ORDER_TOP",
    "ORDER_DEVELOPER_FIRST",
    "ORDER_SYSTEM",
    "ORDER_DEVELOPER_LAST",
  ]);
});
