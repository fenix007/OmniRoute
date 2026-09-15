import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeCodexInputItemIds } from "../../open-sse/executors/codex/inputIds.mjs";

function codePointLength(value) {
  return Array.from(value).length;
}

test("sanitizeCodexInputItemIds preserves 64 code points and deterministically shortens longer IDs", () => {
  const id64 = "a".repeat(64);
  const id65 = "b".repeat(65);
  const unicode65 = "界".repeat(65);
  const body = { input: [{ id: id64 }, { id: id65 }, { id: unicode65 }] };

  sanitizeCodexInputItemIds(body);
  const first = structuredClone(body);
  sanitizeCodexInputItemIds(body);

  assert.equal(body.input[0].id, id64);
  assert.equal(codePointLength(body.input[1].id), 64);
  assert.equal(codePointLength(body.input[2].id), 64);
  assert.deepEqual(body, first);
});

test("sanitizeCodexInputItemIds normalizes supported item IDs without collisions", () => {
  const body = {
    input: [
      { type: "message", id: "item_message" },
      { type: "message", id: "msg_item_message" },
      { type: "message", id: "msgpack-local" },
      { type: "function_call", id: "item_call", call_id: "call-1" },
      { type: "custom_tool_call", id: "item_custom", call_id: "call-2" },
      { type: "custom_tool_call_output", id: "item_custom_output", call_id: "call-2" },
      { type: "function_call_output", id: "item_output", call_id: "call-1" },
    ],
  };

  sanitizeCodexInputItemIds(body);
  const normalized = body.input.map((item) => item.id);

  assert.notEqual(normalized[0], normalized[1]);
  assert.equal(normalized[1], "msg_item_message");
  assert.equal(normalized[2], "msgpack-local");
  assert.equal(normalized[3], "fc_item_call");
  assert.equal(normalized[4], "ctc_item_custom");
  assert.equal(normalized[5], "ctco_item_custom_output");
  assert.equal(normalized[6], "item_output");

  const first = structuredClone(body);
  sanitizeCodexInputItemIds(body);
  assert.deepEqual(body, first);
});

test("sanitizeCodexInputItemIds drops only overlong encrypted reasoning items", () => {
  const longReasoningId = `rs_${"a".repeat(64)}`;
  const body = {
    input: [
      { type: "reasoning", id: longReasoningId, encrypted_content: "encrypted" },
      { type: "reasoning", id: longReasoningId, encrypted_content: "" },
      { type: "message", id: "msg-ok", role: "user", content: "continue" },
    ],
  };

  sanitizeCodexInputItemIds(body);

  assert.equal(body.input.length, 2);
  assert.equal(body.input[0].type, "reasoning");
  assert.equal(codePointLength(body.input[0].id), 64);
  assert.equal(body.input[1].id, "msg-ok");
});

test("sanitizeCodexInputItemIds avoids existing shortened-ID collisions", () => {
  const longId = "grok-item-".repeat(10);
  const firstBody = { input: [{ id: longId }] };
  sanitizeCodexInputItemIds(firstBody);
  const collidingId = firstBody.input[0].id;
  const body = { input: [{ id: longId }, { id: collidingId }] };

  sanitizeCodexInputItemIds(body);

  assert.notEqual(body.input[0].id, collidingId);
  assert.equal(body.input[1].id, collidingId);
  assert.equal(codePointLength(body.input[0].id), 64);
});
