import test from "node:test";
import assert from "node:assert/strict";

import { isReusableDeduplicatedExecutionResult } from "../../open-sse/handlers/chatCore/responseHeaders.ts";

function executionResult(status: number, payload: unknown) {
  return {
    _dedupSnapshot: {
      status,
      statusText: "",
      headers: [["content-type", "application/json"]] as [string, string][],
      payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    },
  };
}

test("only a successful completion envelope is reusable", () => {
  const valid = executionResult(200, {
    choices: [{ message: { role: "assistant", content: "usable" }, finish_reason: "stop" }],
  });
  const empty = executionResult(200, {
    choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
  });
  const error = executionResult(422, { error: { message: "invalid" } });

  assert.equal(isReusableDeduplicatedExecutionResult(valid), true);
  assert.equal(isReusableDeduplicatedExecutionResult(empty), false);
  assert.equal(isReusableDeduplicatedExecutionResult(error), false);
});

test("unknown provider envelopes and incomplete Responses output are not reusable", () => {
  const unknownEmptyEnvelope = executionResult(200, { candidates: [] });
  const incomplete = executionResult(200, {
    object: "response",
    status: "incomplete",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: '{"requirements":[],"domain":null}' }],
      },
    ],
  });

  assert.equal(isReusableDeduplicatedExecutionResult(unknownEmptyEnvelope), false);
  assert.equal(isReusableDeduplicatedExecutionResult(incomplete), false);
});

test("an empty Claude text block is not reusable", () => {
  const emptyClaudeMessage = executionResult(200, {
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stop_reason: "end_turn",
  });

  assert.equal(isReusableDeduplicatedExecutionResult(emptyClaudeMessage), false);
});
