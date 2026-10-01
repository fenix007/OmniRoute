import test from "node:test";
import assert from "node:assert/strict";

import { CodexExecutor, normalizeCodexTools } from "../../open-sse/executors/codex.ts";
import { filterToOpenAIFormat } from "../../open-sse/translator/helpers/openaiHelper.ts";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.ts";

const FUNCTION = {
  type: "function",
  name: "lookup",
  parameters: { type: "object", properties: {} },
  defer_loading: true,
};
const EMPTY_TOOL_CASES = [
  { name: "absent tools", fields: {} },
  { name: "empty tools", fields: { tools: [] } },
  { name: "invalid function filtered out", fields: { tools: [{ type: "function", name: " " }] } },
  { name: "sole image tool removed", fields: { tools: [{ type: "image_generation" }] } },
];

for (const choice of ["auto", "none"]) {
  for (const scenario of EMPTY_TOOL_CASES) {
    test(`Codex normalizer removes ${choice} with ${scenario.name}`, () => {
      const body: Record<string, unknown> = {
        ...structuredClone(scenario.fields),
        tool_choice: choice,
      };
      normalizeCodexTools(body, { dropImageGeneration: true });
      assert.equal(Object.hasOwn(body, "tool_choice"), false);
    });

    for (const native of [true, false]) {
      test(`Codex executor removes ${choice} with ${scenario.name} (native=${native})`, () => {
        const result = new CodexExecutor().transformRequest(
          "gpt-6-astra",
          {
            input: [
              { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
            ],
            ...structuredClone(scenario.fields),
            tool_choice: choice,
            _nativeCodexPassthrough: native,
          },
          true,
          {
            requestEndpointPath: "/responses",
            providerSpecificData: { workspacePlanType: "free" },
          }
        ) as Record<string, unknown>;
        assert.equal(Object.hasOwn(result, "tool_choice"), false);
      });
    }
  }
}

for (const choice of ["auto", "none", "required", { type: "function", name: "lookup" }]) {
  test(`Codex preserves ${JSON.stringify(choice)} and deferred tools when tools survive`, () => {
    for (const native of [true, false]) {
      const result = new CodexExecutor().transformRequest(
        "gpt-6-astra",
        {
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
          tools: [{ type: "tool_search" }, structuredClone(FUNCTION)],
          tool_choice: structuredClone(choice),
          _nativeCodexPassthrough: native,
        },
        true,
        { requestEndpointPath: "/responses" }
      ) as Record<string, unknown>;
      assert.deepEqual(result.tool_choice, choice);
      const tools = result.tools as Record<string, unknown>[];
      assert.equal(tools.find((tool) => tool.name === "lookup")?.defer_loading, true);
      assert.ok(tools.some((tool) => tool.type === "tool_search"));
    }
  });
}

for (const choice of ["auto", "none", { type: "auto" }]) {
  for (const fields of [{}, { tools: [] }, { tools: [{ functionDeclarations: [] }] }]) {
    test(`OpenAI cleanup removes ${JSON.stringify(choice)} without tools: ${JSON.stringify(fields)}`, () => {
      const result = filterToOpenAIFormat({
        messages: [{ role: "user", content: "hi" }],
        ...structuredClone(fields),
        tool_choice: structuredClone(choice),
      });
      assert.equal(Object.hasOwn(result, "tools"), false);
      assert.equal(Object.hasOwn(result, "tool_choice"), false);
    });
  }
}

for (const type of ["tool_search", "image_generation"]) {
  test(`Responses hosted-only ${type} loses automatic choice during OpenAI cleanup`, () => {
    const translated = openaiResponsesToOpenAIRequest(
      "gpt-6-astra",
      { input: "hi", tools: [{ type }], tool_choice: "auto" },
      false,
      {}
    );
    const result = filterToOpenAIFormat(translated);
    assert.equal(Object.hasOwn(result, "tools"), false);
    assert.equal(Object.hasOwn(result, "tool_choice"), false);
  });
}

test("Responses mixed hosted/deferred tools keep automatic choice and surviving function", () => {
  const translated = openaiResponsesToOpenAIRequest(
    "gpt-6-astra",
    {
      input: "hi",
      tools: [{ type: "tool_search" }, structuredClone(FUNCTION)],
      tool_choice: "auto",
    },
    false,
    {}
  );
  const result = filterToOpenAIFormat(translated);
  assert.equal(result.tool_choice, "auto");
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].function.name, "lookup");
});

test("OpenAI cleanup preserves forced choices rather than silently making them optional", () => {
  for (const choice of ["required", { type: "function", function: { name: "lookup" } }]) {
    const result = filterToOpenAIFormat({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      tool_choice: structuredClone(choice),
    });
    assert.deepEqual(result.tool_choice, choice);
  }
  const body = { tool_choice: "required", tools: [] };
  normalizeCodexTools(body);
  assert.equal(body.tool_choice, "required");
});
