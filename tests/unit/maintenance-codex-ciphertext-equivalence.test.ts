import assert from "node:assert/strict";
import test from "node:test";
import { CodexExecutor } from "../../open-sse/executors/codex.ts";

for (const native of [true, false]) {
  test(`Codex already removes account-bound replay ciphertext on every account: native=${native}`, () => {
    const body = {
      _nativeCodexPassthrough: native,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        {
          type: "reasoning",
          id: "rs_previous",
          encrypted_content: "account-one-only",
          summary: [],
        },
        {
          type: "function_call",
          id: "fc_previous",
          call_id: "call_lookup",
          name: "lookup",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "call_lookup", output: "ok" },
      ],
    };
    const before = structuredClone(body);
    for (const connectionId of ["first", "second"]) {
      const result = new CodexExecutor().transformRequest("gpt-6-astra", body, true, {
        connectionId,
        accessToken: `test-${connectionId}`,
        providerSpecificData: {},
      }) as typeof body;
      assert.equal(JSON.stringify(result).includes("account-one-only"), false);
      assert.equal(JSON.stringify(result).includes("rs_previous"), false);
      assert.ok(result.input.some((item) => item.type === "function_call"));
      assert.ok(result.input.some((item) => item.type === "function_call_output"));
      assert.deepEqual(body, before);
    }
  });
}
