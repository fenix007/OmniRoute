import test from "node:test";
import assert from "node:assert/strict";

const { sanitizeGeminiToolName, buildGeminiTools } =
  await import("../../open-sse/translator/helpers/geminiToolsSanitizer.ts");
const { openaiToGeminiRequest, openaiToCloudCodeGeminiRequest } =
  await import("../../open-sse/translator/request/openai-to-gemini.ts");
const { claudeToGeminiRequest } =
  await import("../../open-sse/translator/request/claude-to-gemini.ts");
const { remapToolNamesInResponse } =
  await import("../../open-sse/services/claudeCodeToolRemapper.ts");

// ── Gemini tool names must start with a letter or underscore (#13715) ──

const GEMINI_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

test("sanitizeGeminiToolName: a tool name starting with a digit gets a letter prefix (#13715)", () => {
  const sanitized = sanitizeGeminiToolName("1c_ssl_mcp_plugin_reload");

  assert.match(
    sanitized,
    GEMINI_NAME_PATTERN,
    "Gemini rejects 'Invalid function name. Must start with a letter or an underscore' for the whole request"
  );
  assert.equal(sanitized, "t1c_ssl_mcp_plugin_reload");
});

test("sanitizeGeminiToolName: an all-digit name is prefixed rather than dropped (#13715)", () => {
  assert.equal(sanitizeGeminiToolName("123"), "t123");
});

test("sanitizeGeminiToolName: already-valid names are untouched (#13715)", () => {
  for (const name of ["bash", "Bash", "read_file", "a1", "MCP_tool"]) {
    assert.equal(sanitizeGeminiToolName(name), name);
  }
});

test("sanitizeGeminiToolName: a digit-led name that also needs character replacement keeps both fixes (#13715)", () => {
  const sanitized = sanitizeGeminiToolName("1c.tool-name");

  assert.match(sanitized, GEMINI_NAME_PATTERN);
  assert.equal(sanitized, "t1c_tool_name");
});

test("sanitizeGeminiToolName: digit-led names stay unique and round-trip through toolNameMap (#13715)", () => {
  const toolNameMap = new Map<string, string>();
  const options = { toolNameMap };

  sanitizeGeminiToolName("1c_ssl_mcp_plugin_reload", options);
  sanitizeGeminiToolName("1c_ssl_mcp_plugin_reload", options);

  assert.equal(toolNameMap.size, 1, "repeat calls reuse the existing mapping");
  assert.equal(toolNameMap.get("t1c_ssl_mcp_plugin_reload"), "1c_ssl_mcp_plugin_reload");
});

test("sanitizeGeminiToolName: the letter prefix keeps the name inside the 64-char Gemini limit (#13715)", () => {
  const longDigitLed = `1${"a".repeat(63)}`;
  const sanitized = sanitizeGeminiToolName(longDigitLed);

  assert.ok(
    sanitized.length <= 64,
    `Gemini caps function names at 64 chars, got ${sanitized.length}`
  );
  assert.match(sanitized, GEMINI_NAME_PATTERN);
});

test("buildGeminiTools: a digit-led declaration is accepted and mapped back to its original name (#13715)", () => {
  const toolNameMap = new Map<string, string>();
  const tools = buildGeminiTools(
    [
      {
        type: "function",
        function: {
          name: "1c_ssl_mcp_plugin_reload",
          description: "Reload the 1C MCP plugin",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    { toolNameMap }
  );

  const name = tools?.[0]?.functionDeclarations?.[0]?.name;
  assert.ok(name, "the declaration survives sanitization");
  assert.match(name, GEMINI_NAME_PATTERN);
  assert.equal(toolNameMap.get(name), "1c_ssl_mcp_plugin_reload");
});

test("digit-prefix collisions retain distinct, stable reverse mappings", () => {
  for (const names of [
    ["1tool", "_1tool", "t1tool"],
    ["t1tool", "_1tool", "1tool"],
  ]) {
    const toolNameMap = new Map<string, string>();
    const wireNames = names.map((name) => sanitizeGeminiToolName(name, { toolNameMap }));
    assert.equal(new Set(wireNames).size, names.length);
    const declarations = buildGeminiTools(
      names.map((name) => ({ name, input_schema: { type: "object", properties: {} } })),
      { toolNameMap }
    );
    assert.deepEqual(
      declarations?.[0]?.functionDeclarations?.map((tool) => tool.name),
      wireNames,
      "collision resolution preserves every declaration"
    );
    assert.deepEqual(
      buildGeminiTools(declarations),
      declarations,
      "the executor's second sanitization preserves already-unique wire names"
    );
    for (const [index, name] of names.entries()) {
      assert.match(wireNames[index], GEMINI_NAME_PATTERN);
      assert.equal(toolNameMap.get(wireNames[index]), name);
      assert.equal(sanitizeGeminiToolName(name, { toolNameMap }), wireNames[index]);
    }
  }
});

test("namespace removal and length boundaries preserve valid digit-led names", () => {
  for (const length of [63, 64, 65, 128]) {
    const original = `namespace:1${"x".repeat(length - 1)}`;
    const toolNameMap = new Map<string, string>();
    const wire = sanitizeGeminiToolName(original, { stripNamespace: true, toolNameMap });
    assert.match(wire, GEMINI_NAME_PATTERN);
    assert.ok(wire.length <= 64);
    assert.equal(toolNameMap.get(wire), original);
  }
});

type ToolRequest = {
  contents: Array<{
    parts: Array<{
      functionCall?: { name: string };
      functionResponse?: { name: string };
    }>;
  }>;
  tools?: Array<{ functionDeclarations?: Array<{ name: string }> }>;
  _toolNameMap?: Map<string, string>;
};

function assertToolRoundTrip(request: ToolRequest, original: string) {
  const wire = request.tools?.[0]?.functionDeclarations?.[0]?.name;
  assert.ok(wire);
  assert.match(wire, GEMINI_NAME_PATTERN);
  const parts = request.contents.flatMap((turn) => turn.parts);
  assert.equal(parts.find((part) => part.functionCall)?.functionCall?.name, wire);
  assert.equal(parts.find((part) => part.functionResponse)?.functionResponse?.name, wire);
  assert.equal(request._toolNameMap?.get(wire), original);
  for (const response of [
    { choices: [{ delta: { tool_calls: [{ function: { name: wire } }] } }] },
    { choices: [{ message: { tool_calls: [{ function: { name: wire } }] } }] },
    { type: "response.output_item.added", item: { type: "function_call", name: wire } },
    { type: "content_block_start", content_block: { type: "tool_use", name: wire } },
  ]) {
    const serialized = JSON.stringify(response);
    assert.equal(
      remapToolNamesInResponse(serialized, true, request._toolNameMap),
      serialized.replace(`"name":"${wire}"`, `"name":"${original}"`)
    );
  }
}

for (const stream of [false, true]) {
  for (const [label, translate] of [
    ["Gemini", openaiToGeminiRequest],
    ["Cloud Code Gemini", openaiToCloudCodeGeminiRequest],
  ] as const) {
    test(`OpenAI -> ${label} keeps digit-led tool identity, stream=${stream}`, () => {
      const name = "1terminal";
      const body = {
        messages: [
          { role: "user", content: "Run command" },
          {
            role: "assistant",
            tool_calls: [
              { id: "call_digit", type: "function", function: { name, arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "call_digit", content: "ok" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name,
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      };
      const before = structuredClone(body);
      assertToolRoundTrip(translate("gemini-2.5-flash", body, stream), name);
      assert.deepEqual(body, before);
    });
  }

  test(`Claude -> Gemini keeps digit-led tool identity, stream=${stream}`, () => {
    const name = "1terminal";
    const body = {
      messages: [
        { role: "user", content: "Run command" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_digit", name, input: {} }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_digit", content: "ok" }],
        },
      ],
      tools: [{ name, input_schema: { type: "object", properties: {} } }],
    };
    const before = structuredClone(body);
    assertToolRoundTrip(
      claudeToGeminiRequest("gemini-2.5-flash", body, stream) as ToolRequest,
      name
    );
    assert.deepEqual(body, before);
  });
}
