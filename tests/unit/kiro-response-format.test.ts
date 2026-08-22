import test from "node:test";
import assert from "node:assert/strict";

const { buildKiroPayload } = await import("../../open-sse/translator/request/openai-to-kiro.ts");
const { buildKiroJsonFormatInstruction } =
  await import("../../open-sse/translator/request/openai-to-kiro/responseFormat.ts");

/**
 * Kiro has no Structured Output request parameter, so `response_format` was
 * dropped silently and strict-schema callers got invented property names back.
 * The contract now rides in the prompt instead.
 */

const RESIDUAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rows", "verdict"],
  properties: {
    rows: {
      type: "array",
      items: { $ref: "#/$defs/row" },
    },
    verdict: { type: "string", enum: ["pass", "fail"] },
  },
  $defs: {
    row: {
      type: "object",
      additionalProperties: false,
      required: ["evidence_kind"],
      properties: { evidence_kind: { type: "string", const: "explicit" } },
    },
  },
};

function contentFor(responseFormat?: unknown): string {
  const payload = buildKiroPayload(
    "claude-haiku-4.5",
    {
      messages: [
        { role: "system", content: "You are a judge." },
        { role: "user", content: "Score this candidate." },
      ],
      ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
    },
    false,
    {}
  ) as {
    conversationState: { currentMessage: { userInputMessage: { content: string } } };
  };
  return payload.conversationState.currentMessage.userInputMessage.content;
}

test("json_schema response_format reaches the model as a prompt contract", () => {
  const content = contentFor({
    type: "json_schema",
    json_schema: { name: "residual", strict: true, schema: RESIDUAL_SCHEMA },
  });

  assert.match(content, /You must respond with valid JSON that strictly follows this JSON schema/);
  assert.match(content, /<system-reminder>[\s\S]*evidence_kind[\s\S]*<\/system-reminder>/);
  assert.match(content, /no markdown code fences/);
  // The user's own turn survives untouched alongside the contract.
  assert.match(content, /Score this candidate\./);
});

test("the embedded schema is verbatim, including strict-only keywords", () => {
  const content = contentFor({
    type: "json_schema",
    json_schema: { name: "residual", strict: true, schema: RESIDUAL_SCHEMA },
  });

  // kiroSanitizer strips additionalProperties/$ref/$defs from *tool* schemas —
  // a prompt-embedded schema must not go through it or the contract loses the
  // very keywords that make it strict.
  assert.ok(content.includes(JSON.stringify(RESIDUAL_SCHEMA, null, 2)));
});

test("the contract is appended last, after the user turn", () => {
  const content = contentFor({
    type: "json_schema",
    json_schema: { schema: RESIDUAL_SCHEMA },
  });

  const userTurn = content.indexOf("Score this candidate.");
  const contract = content.indexOf("You must respond with valid JSON");
  assert.ok(userTurn >= 0 && contract > userTurn, "contract must follow the user turn");
  assert.ok(content.trimEnd().endsWith("</system-reminder>"));
});

test("json_object asks for JSON without inventing a schema block", () => {
  const content = contentFor({ type: "json_object" });

  assert.match(content, /You must respond with valid JSON\. Respond with the JSON value only/);
  assert.ok(!content.includes("follows this JSON schema"));
});

test("requests without a JSON contract are left alone", () => {
  for (const format of [undefined, { type: "text" }, { type: "json_schema" }]) {
    const content = contentFor(format);
    assert.ok(
      !content.includes("You must respond with valid JSON"),
      `unexpected contract for ${JSON.stringify(format)}`
    );
  }
});

test("buildKiroJsonFormatInstruction rejects non-format values", () => {
  for (const value of [null, undefined, "json_object", 42, [{ type: "json_object" }]]) {
    assert.equal(buildKiroJsonFormatInstruction(value), null);
  }
});
