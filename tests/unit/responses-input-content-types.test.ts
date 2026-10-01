import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeResponsesInputItems } from "../../open-sse/services/responsesInputSanitizer.ts";
import { CodexExecutor } from "../../open-sse/executors/codex.ts";

const outputText = {
  type: "output_text",
  text: "Preserve this text",
  annotations: [],
  logprobs: [],
  obfuscation: "output-only",
};

for (const role of ["user", "system", "developer"]) {
  test(`replayed output_text in ${role} content becomes input_text`, () => {
    const input = [{ type: "message", role, content: [structuredClone(outputText)] }];
    const before = structuredClone(input);
    const result = sanitizeResponsesInputItems(input);
    assert.deepEqual(result, [
      { type: "message", role, content: [{ type: "input_text", text: outputText.text }] },
    ]);
    assert.deepEqual(input, before, "normalization must not mutate the caller's history");
    assert.deepEqual(sanitizeResponsesInputItems(result), result, "normalization is idempotent");
  });
}

for (const type of ["function_call_output", "custom_tool_call_output"]) {
  test(`${type} uses input content types for replayed text and images`, () => {
    const input = [
      {
        type,
        call_id: "call_1",
        output: [
          structuredClone(outputText),
          { type: "image_url", image_url: { url: "https://example.com/result.png" } },
          { type: "input_file", file_id: "file_1" },
          { type: "scoped_content", content: "opaque" },
        ],
      },
    ];
    assert.deepEqual(sanitizeResponsesInputItems(input), [
      {
        type,
        call_id: "call_1",
        output: [
          { type: "input_text", text: outputText.text },
          { type: "input_image", image_url: "https://example.com/result.png" },
          { type: "input_file", file_id: "file_1" },
          { type: "scoped_content", content: "opaque" },
        ],
      },
    ]);
  });
}

test("assistant output_text and its metadata survive replay", () => {
  const input = [{ type: "message", role: "assistant", content: [outputText] }];
  assert.deepEqual(sanitizeResponsesInputItems(input), input);
});

for (const native of [true, false]) {
  test(`Codex executor normalizes mixed replay content (native=${native})`, () => {
    const result = new CodexExecutor().transformRequest(
      "gpt-6-sol",
      {
        _nativeCodexPassthrough: native,
        input: [
          { type: "message", role: "developer", content: [structuredClone(outputText)] },
          { type: "message", role: "user", content: [structuredClone(outputText)] },
          { type: "message", role: "assistant", content: [structuredClone(outputText)] },
          { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: [structuredClone(outputText)],
          },
          { type: "custom_tool_call", call_id: "call_2", name: "apply_patch", input: "patch" },
          {
            type: "custom_tool_call_output",
            call_id: "call_2",
            output: [structuredClone(outputText)],
          },
        ],
      },
      true,
      { requestEndpointPath: "/responses" }
    ) as { input: Array<Record<string, unknown>> };
    for (const item of result.input) {
      if (item.type === "message") {
        const part = (item.content as Array<Record<string, unknown>>)[0];
        assert.equal(part.type, item.role === "assistant" ? "output_text" : "input_text");
        assert.equal(part.text, outputText.text);
      } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
        assert.deepEqual(item.output, [{ type: "input_text", text: outputText.text }]);
      }
    }
  });
}
