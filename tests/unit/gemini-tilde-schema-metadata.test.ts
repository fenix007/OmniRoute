import assert from "node:assert/strict";
import test from "node:test";

import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/helpers/geminiHelper.ts";
import { buildGeminiTools } from "../../open-sse/translator/helpers/geminiToolsSanitizer.ts";
import { claudeToGeminiRequest } from "../../open-sse/translator/request/claude-to-gemini.ts";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";

// #14279: remove provider-incompatible metadata, not a caller's argument names.
function schemaPair() {
  const expected = {
    type: "object",
    properties: {
      "~optional": { type: "string", description: "literal ~optional argument" },
      "~standard": { type: "string", enum: ["~optional", "~standard"] },
      plain: { type: "string", pattern: "^~" },
    },
    required: ["~optional", "~standard", "plain"],
  };
  const input = {
    ...structuredClone(expected),
    "~standard": { version: 1, vendor: "fixture" },
    "~vendor": ["metadata"],
    properties: {
      ...structuredClone(expected.properties),
      "~optional": { ...expected.properties["~optional"], "~optional": true },
      plain: { ...expected.properties.plain, "~vendor": { nested: true } },
    },
  };
  return { input, expected };
}

test("strips tilde metadata while retaining required tilde-named arguments and values", () => {
  const { input, expected } = schemaPair();
  const before = structuredClone(input);
  const cleaned = cleanJSONSchemaForAntigravity(input);
  assert.deepEqual(cleaned, expected);
  assert.deepEqual(input, before);
  assert.deepEqual(cleanJSONSchemaForAntigravity(cleaned), expected);
});

test("cleans nested objects and array items without losing tilde property names", () => {
  const { input, expected } = schemaPair();
  const schema = {
    type: "object",
    properties: {
      "~nested": input,
      rows: { type: "array", "~optional": true, items: input },
    },
    required: ["~nested", "rows"],
  };
  assert.deepEqual(cleanJSONSchemaForAntigravity(schema), {
    type: "object",
    properties: {
      "~nested": expected,
      rows: { type: "array", items: expected },
    },
    required: ["~nested", "rows"],
  });
});

test("cleans metadata after composition and escaped local-reference expansion", () => {
  const { input, expected } = schemaPair();
  const schema = {
    type: "object",
    $defs: { "~entry": input },
    properties: {
      referenced: { $ref: "#/$defs/~0entry" },
      combined: { type: "object", allOf: [input] },
      choice: { anyOf: [{ type: "null" }, input] },
      exclusive: { oneOf: [input] },
    },
  };
  const before = structuredClone(schema);
  assert.deepEqual(cleanJSONSchemaForAntigravity(schema), {
    type: "object",
    properties: {
      referenced: expected,
      combined: expected,
      choice: expected,
      exclusive: expected,
    },
  });
  assert.deepEqual(schema, before);
});

test("does not change metadata-free schemas or empty-object placeholders", () => {
  const { expected } = schemaPair();
  assert.deepEqual(cleanJSONSchemaForAntigravity(expected), expected);
  assert.deepEqual(
    cleanJSONSchemaForAntigravity({ type: "object", "~optional": true }),
    cleanJSONSchemaForAntigravity({ type: "object" })
  );
});

test("buildGeminiTools removes metadata from the emitted declaration", () => {
  const { input, expected } = schemaPair();
  const tools = [{ type: "function", function: { name: "inspect", parameters: input } }];
  const before = structuredClone(tools);
  assert.deepEqual(buildGeminiTools(tools)?.[0]?.functionDeclarations?.[0]?.parameters, expected);
  assert.deepEqual(tools, before);
});

for (const stream of [false, true]) {
  test(`OpenAI tools and response schemas omit metadata (stream=${stream})`, () => {
    const { input, expected } = schemaPair();
    const body = {
      messages: [{ role: "user", content: "Inspect the object" }],
      tools: [{ type: "function", function: { name: "inspect", parameters: input } }],
      response_format: { type: "json_schema", json_schema: { name: "result", schema: input } },
    };
    const before = structuredClone(body);
    const translated = openaiToGeminiRequest("gemini-2.5-pro", body, stream);
    assert.deepEqual(translated.tools?.[0]?.functionDeclarations?.[0]?.parameters, expected);
    assert.deepEqual(translated.generationConfig?.responseSchema, expected);
    assert.deepEqual(body, before);
  });

  test(`Claude tools omit metadata on the direct Gemini path (stream=${stream})`, () => {
    const { input, expected } = schemaPair();
    const body = {
      messages: [{ role: "user", content: "Inspect the object" }],
      tools: [{ name: "inspect", input_schema: input }],
    };
    const before = structuredClone(body);
    const translated = claudeToGeminiRequest("gemini-2.5-pro", body, stream);
    assert.deepEqual(translated.tools?.[0]?.functionDeclarations?.[0]?.parameters, expected);
    assert.deepEqual(body, before);
  });
}
