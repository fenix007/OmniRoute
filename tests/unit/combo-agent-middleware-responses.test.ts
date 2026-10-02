/**
 * Combo agent middleware must keep Responses API bodies in Responses shape.
 *
 * It used to write `messages: []` into every body, so a Codex CLI `/v1/responses`
 * request reached each combo target with both `input` and `messages`. The Codex
 * executor drops `messages`, but the OpenAI Responses upstream rejects it:
 * `400 Unsupported parameter: 'messages'` — the combo fallback leg always failed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-mw-responses-"));

const { applyComboAgentMiddleware } =
  await import("../../open-sse/services/comboAgentMiddleware.ts");
const { handleComboChat } = await import("../../open-sse/services/combo.ts");

const responsesInput = [
  { type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] },
];

for (const [name, comboConfig, expectedInstructions] of [
  ["no combo features", { context_cache_protection: true }, "client instructions"],
  ["system message override", { system_message: "combo system" }, "combo system"],
  ["blank system message", { system_message: "   " }, "client instructions"],
] as const) {
  test(`Responses body never gains messages: ${name}`, () => {
    const body = {
      model: "gpt-6.1-sol",
      instructions: "client instructions",
      input: responsesInput,
    };
    const result = applyComboAgentMiddleware(body, comboConfig, "openai/gpt-6.1-sol");
    assert.equal("messages" in result.body, false);
    assert.deepEqual(result.body.input, responsesInput);
    assert.equal(result.body.instructions, expectedInstructions);
  });
}

test("Responses body without instructions gets the combo system message as instructions", () => {
  const result = applyComboAgentMiddleware(
    { model: "gpt-6.1-sol", input: "ping" },
    { system_message: "combo system" },
    "openai/gpt-6.1-sol"
  );
  assert.equal("messages" in result.body, false);
  assert.equal(result.body.instructions, "combo system");
  assert.equal(result.body.input, "ping");
});

test("Chat Completions body keeps the messages contract", () => {
  const result = applyComboAgentMiddleware(
    { model: "combo/default", messages: [{ role: "user", content: "hello" }] },
    { system_message: "combo system" },
    "openai/gpt-4o"
  );
  assert.deepEqual(result.body.messages, [
    { role: "system", content: "combo system" },
    { role: "user", content: "hello" },
  ]);
  assert.equal(result.body.instructions, undefined);
});

test("combo fallback leg receives the Codex Responses body without messages", async () => {
  const seen: Array<{ model: string; body: Record<string, unknown> }> = [];
  const response = await handleComboChat({
    body: {
      model: "gpt-6.1-sol",
      input: responsesInput,
      reasoning: { effort: "medium", context: "all_turns" },
      stream: false,
    },
    combo: {
      name: "gpt-6.1-sol",
      strategy: "priority",
      models: ["codex/gpt-6.1-sol", "openai/gpt-6.1-sol"],
    },
    handleSingleModel: async (body: Record<string, unknown>, model: string) => {
      seen.push({ model, body });
      if (model.startsWith("codex/")) {
        return Response.json(
          { error: { message: "upstream rejected", type: "invalid_request_error" } },
          { status: 400 }
        );
      }
      return Response.json({
        id: "resp_1",
        object: "response",
        status: "completed",
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "pong" }] },
        ],
      });
    },
    isModelAvailable: async () => true,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    settings: {},
    allCombos: [],
    relayOptions: undefined,
    signal: null,
  } as never);

  assert.equal(response.status, 200);
  assert.deepEqual(
    seen.map((attempt) => attempt.model),
    ["codex/gpt-6.1-sol", "openai/gpt-6.1-sol"]
  );
  for (const attempt of seen) {
    assert.equal("messages" in attempt.body, false, `${attempt.model} got messages`);
    assert.deepEqual(attempt.body.input, responsesInput);
  }
});
