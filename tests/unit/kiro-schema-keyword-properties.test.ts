import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeKiroTools } from "../../open-sse/utils/kiroSanitizer.ts";
import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro.ts";

function sanitizeOne(schema: Record<string, unknown>) {
  return sanitizeKiroTools([
    { toolSpecification: { name: "inspect", inputSchema: { json: schema } } },
  ]).tools[0].toolSpecification.inputSchema.json;
}

test("Kiro preserves keyword-named parameters while stripping actual schema keywords", () => {
  const names = [
    "additionalProperties",
    "anyOf",
    "oneOf",
    "allOf",
    "not",
    "$schema",
    "$id",
    "$ref",
    "$defs",
    "definitions",
    "if",
    "then",
    "else",
    "unevaluatedProperties",
    "unevaluatedItems",
    "contentEncoding",
    "contentMediaType",
    "required",
  ];
  const properties = Object.fromEntries(names.map((name) => [name, { type: "string" }]));
  const schema = { type: "object", properties, required: names, additionalProperties: false };
  const before = structuredClone(schema);
  assert.deepEqual(sanitizeOne(schema), { type: "object", properties, required: names });
  assert.deepEqual(schema, before);
});

test("Kiro keeps names recursively inside array items and nested name maps", () => {
  assert.deepEqual(
    sanitizeOne({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              if: { type: "string", $ref: "#/$defs/Value" },
              properties: { type: "object", properties: { not: { type: "boolean" } } },
            },
            required: ["if"],
            additionalProperties: false,
          },
        },
      },
    }),
    {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              if: { type: "string" },
              properties: { type: "object", properties: { not: { type: "boolean" } } },
            },
            required: ["if"],
          },
        },
      },
      required: [],
    }
  );
});

test("Kiro preserves pattern names but sanitizes their schemas", () => {
  assert.deepEqual(
    sanitizeOne({
      type: "object",
      patternProperties: {
        if: { type: "string", if: { const: "x" }, then: { minLength: 2 } },
        "^x-": { type: "object", properties: { $ref: { type: "string" } } },
      },
    }),
    {
      type: "object",
      patternProperties: {
        if: { type: "string" },
        "^x-": { type: "object", properties: { $ref: { type: "string" } } },
      },
      required: [],
    }
  );
});

test("Kiro preserves special property names as own data properties", () => {
  const properties = JSON.parse('{"__proto__":{"type":"string"},"constructor":{"type":"number"}}');
  const result = sanitizeOne({ type: "object", properties });
  assert.deepEqual(result.properties, properties);
  assert.equal(Object.getPrototypeOf(result.properties), Object.prototype);
  assert.equal(Object.hasOwn(result.properties, "__proto__"), true);
});

test("Kiro retains the existing union, required and boolean-schema contracts", () => {
  assert.deepEqual(
    sanitizeOne({
      oneOf: [{ properties: { a: { type: "string" } } }],
      properties: { not: false, if: true, plain: { type: "object", required: [] } },
      required: ["ghost", "ghost"],
    }),
    {
      properties: { not: false, if: true, plain: { type: "object" } },
      required: ["ghost", "ghost"],
    }
  );
});

test("Kiro leaves malformed non-map properties on the existing traversal path", () => {
  for (const properties of [null, false, "unchanged", [{ if: true, type: "string" }]]) {
    const expected = Array.isArray(properties) ? [{ type: "string" }] : properties;
    assert.deepEqual(sanitizeOne({ properties }), { properties: expected, required: [] });
  }
});

for (const stream of [false, true]) {
  for (const format of ["openai", "claude"]) {
    test(`Kiro ${format} tool translation preserves keyword arguments (stream=${stream})`, () => {
      const schema = {
        type: "object",
        properties: { if: { type: "string" }, not: { type: "boolean" } },
        required: ["if"],
        additionalProperties: false,
      };
      const tool =
        format === "openai"
          ? { type: "function", function: { name: "inspect", parameters: schema } }
          : { name: "inspect", input_schema: schema };
      const body = {
        messages: [{ role: "user", content: "Inspect the condition." }],
        tools: [tool],
      };
      const before = structuredClone(body);
      const payload = buildKiroPayload("claude-sonnet-4.5", body, stream, {});
      const tools =
        payload.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools;
      const sanitized = sanitizeKiroTools(tools);
      assert.deepEqual(sanitized.tools[0].toolSpecification.inputSchema.json, {
        type: "object",
        properties: schema.properties,
        required: ["if"],
      });
      assert.equal(sanitized.tools[0].toolSpecification.name, "inspect");
      assert.equal(sanitized.nameMap.size, 0);
      assert.deepEqual(body, before);
    });
  }
}
