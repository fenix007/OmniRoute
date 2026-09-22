import test from "node:test";
import assert from "node:assert/strict";
import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

const h = await createChatPipelineHarness("combo-codex-account-timeout");
const { updateProviderConnection } = await import("../../src/lib/db/providers.ts");
const { clearSessions } = await import("../../open-sse/services/sessionManager.ts");

test.beforeEach(async () => {
  await h.resetStorage();
});
test.afterEach(async () => {
  clearSessions();
  await h.resetStorage();
});
test.after(async () => {
  await h.cleanup();
});

function codexResponse() {
  const response = {
    id: "resp_retry",
    object: "response",
    model: "gpt-5.6-sol",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Alternate Codex answered" }],
      },
    ],
    usage: { input_tokens: 8, output_tokens: 4 },
  };
  return new Response(
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

for (const mode of ["recover", "both-timeout", "allowlist", "cooldown", "disabled"] as const) {
  test(`Codex timeout before compatible fallback: ${mode}`, async () => {
    const first = await h.seedConnection("codex", { name: "first", priority: 1 });
    const second = await h.seedConnection("codex", { name: "second", priority: 2 });
    await updateProviderConnection(first.id, { accessToken: "test-first", authType: "oauth" });
    await updateProviderConnection(second.id, {
      accessToken: "test-second",
      authType: "oauth",
      ...(mode === "cooldown"
        ? {
            testStatus: "unavailable",
            rateLimitedUntil: new Date(Date.now() + 3600000).toISOString(),
          }
        : {}),
    });
    const fallback = await h.seedConnection("openai", { apiKey: "test-fallback" });
    await h.combosDb.createCombo({
      name: "coding-account-retry",
      strategy: "priority",
      config: {
        maxRetries: 0,
        targetTimeoutMs: 1500,
        retryDelayMs: 0,
        retryCodexAccountOnTimeout: mode !== "disabled",
      },
      models: ["codex/gpt-5.6-sol-medium", "openai/gpt-5.6-sol"],
    });
    const apiKey =
      mode === "allowlist"
        ? await h.seedApiKey({ allowedConnections: [first.id, fallback.id] })
        : null;
    const attempts: string[] = [];
    globalThis.fetch = async (url, init: RequestInit = {}) => {
      const address = String(url);
      if (address.includes("/usage"))
        return new Response("{}", { headers: { "Content-Type": "application/json" } });
      if (address.includes("chatgpt.com/backend-api/codex/responses")) {
        const token = new Headers(init.headers).get("authorization");
        const account = token === "Bearer test-first" ? "first" : "second";
        attempts.push(account);
        if (account === "second" && mode === "recover") return codexResponse();
        return new Promise<Response>((_resolve, reject) => {
          const abort = () =>
            reject(Object.assign(new Error("combo deadline"), { name: "AbortError" }));
          if (init.signal?.aborted) abort();
          else init.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      attempts.push("fallback");
      return h.buildOpenAIResponse("Fallback answered", "gpt-5.6-sol");
    };
    const result = await h.handleChat(
      h.buildRequest({
        authKey: apiKey?.key,
        body: {
          model: "coding-account-retry",
          stream: false,
          messages: [{ role: "user", content: `Request ${mode}` }],
        },
      })
    );
    assert.equal(result.status, 200, await result.clone().text());
    const payload = await result.json();
    assert.deepEqual(
      attempts,
      mode === "recover"
        ? ["first", "second"]
        : mode === "both-timeout"
          ? ["first", "second", "fallback"]
          : ["first", "fallback"]
    );
    assert.equal(
      payload.choices[0].message.content,
      mode === "recover" ? "Alternate Codex answered" : "Fallback answered"
    );
  });
}
