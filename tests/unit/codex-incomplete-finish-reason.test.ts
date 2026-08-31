import test from "node:test";
import assert from "node:assert/strict";

import { translateNonStreamingResponse } from "../../open-sse/handlers/responseTranslator.ts";
import { parseSSEToResponsesOutput } from "../../open-sse/handlers/sseParser.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

function translateBufferedResponsesSSE(rawSSE: string) {
  const parsed = parseSSEToResponsesOutput(rawSSE, "gpt-5.6-sol");
  assert.ok(parsed);
  return {
    parsed,
    translated: translateNonStreamingResponse(parsed, FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI) as {
      choices: Array<{
        finish_reason: string;
        message: { content: string };
      }>;
    },
  };
}

test("buffered Codex response.incomplete maps max_output_tokens to finish_reason length", () => {
  const partialProfile = JSON.stringify({ requirements: [], domain: null });
  const rawSSE = [
    "event: response.incomplete",
    `data: ${JSON.stringify({
      type: "response.incomplete",
      response: {
        id: "resp_incomplete",
        object: "response",
        model: "gpt-5.6-sol",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: partialProfile }],
          },
        ],
      },
    })}`,
    "",
  ].join("\n");

  const { parsed, translated } = translateBufferedResponsesSSE(rawSSE);

  assert.equal(parsed.status, "incomplete");
  assert.deepEqual(parsed.incomplete_details, { reason: "max_output_tokens" });
  assert.equal(translated.choices[0].message.content, partialProfile);
  assert.equal(translated.choices[0].finish_reason, "length");
});

test("buffered Codex response.completed remains finish_reason stop", () => {
  const rawSSE = [
    "event: response.completed",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_completed",
        object: "response",
        model: "gpt-5.6-sol",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: '{"requirements":["TypeScript"]}' }],
          },
        ],
      },
    })}`,
    "",
  ].join("\n");

  const { translated } = translateBufferedResponsesSSE(rawSSE);

  assert.equal(translated.choices[0].finish_reason, "stop");
});
