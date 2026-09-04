import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("chat-messages-entry-objects-12643");
const { handleChat, buildRequest, resetStorage, seedConnection } = harness;

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await harness.cleanup();
});

async function postMessages(messages: unknown) {
  await seedConnection("anthropic", { apiKey: "sk-ant" });

  let upstreamCalled = false;
  globalThis.fetch = async () => {
    upstreamCalled = true;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  const response = await handleChat(
    buildRequest({
      body: {
        model: "anthropic/claude-haiku-4-5",
        messages,
      },
    })
  );
  const body = (await response.json()) as { error?: { message?: string } };
  return { response, body, upstreamCalled };
}

test("#12643: non-object message entries return 400 without an upstream call", async () => {
  for (const messages of [[null], [{ role: "user", content: "hi" }, "oops"], [42], [[]]]) {
    const { response, body, upstreamCalled } = await postMessages(messages);

    assert.equal(response.status, 400, `must be a 400: ${JSON.stringify(messages)}`);
    assert.match(body.error?.message ?? "", /Expected array of objects/i);
    assert.equal(upstreamCalled, false, "must not forward invalid messages upstream");
  }
});

test("#12643: a well-formed message passes the entry guard", async () => {
  const { response, body } = await postMessages([{ role: "user", content: "hi" }]);

  assert.ok(
    !(response.status === 400 && /Expected array of objects/i.test(body.error?.message ?? ""))
  );
});
