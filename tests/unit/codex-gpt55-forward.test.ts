import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gpt55-forward-"));
process.env.DATA_DIR = dataDir;
process.env.OMNIROUTE_WS_BRIDGE_SECRET = "gpt55-forward-test-bridge-secret";

const core = await import("../../src/lib/db/core.ts");
const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
const { setModelAlias } = await import("../../src/lib/db/models.ts");
const { getModelInfo } = await import("../../src/sse/services/model.ts");
const { resolveModelOrError } = await import("../../src/sse/handlers/chatHelpers.ts");
const { getProviderCredentials } = await import("../../src/sse/services/auth.ts");
const { lockUnsupportedAccountModel } = await import("../../open-sse/services/accountFallback.ts");
const { CodexExecutor } = await import("../../open-sse/executors/codex.ts");
const { POST: prepareWs } = await import("../../src/app/api/internal/codex-responses-ws/route.ts");
const { resolveCodexWsModelInfo, resolveResponsesApiModel } =
  await import("../../src/app/api/internal/codex-responses-ws/modelResolution.ts");

let connectionId: string;
test.before(async () => {
  const connection = await createProviderConnection({
    provider: "codex",
    authType: "oauth",
    isActive: true,
    testStatus: "active",
    accessToken: "test-access-token",
  });
  connectionId = String(connection.id);
  lockUnsupportedAccountModel("codex", connectionId, "gpt-5.5");
  // Production still has a legacy bare alias pointing to a compatible node.
  await setModelAlias("gpt-5.5", "openai-compatible-chat-legacy/gpt-5.5");
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

for (const prefix of ["", "cx/", "codex/"]) {
  test(`${prefix}gpt-5.5 forwards before HTTP credential selection and existing locks`, async () => {
    for (const endpoint of ["/v1/chat/completions", "/v1/responses"]) {
      const resolved = await resolveModelOrError(
        `${prefix}gpt-5.5`,
        { messages: [{ role: "user", content: "Hello" }] },
        endpoint,
        null
      );
      assert.equal(resolved.provider, "codex");
      assert.equal(resolved.model, "gpt-6.1-sol");
      const credentials = await getProviderCredentials(
        resolved.provider,
        null,
        null,
        resolved.model
      );
      assert.equal(credentials?.connectionId, connectionId);
    }
  });

  test(`${prefix}gpt-5.5 resolves for Responses HTTP and WebSocket`, async () => {
    const requested = `${prefix}gpt-5.5`;
    const http = await resolveResponsesApiModel(requested, getModelInfo);
    const httpInfo = await getModelInfo(http.model);
    const wsInfo = await resolveCodexWsModelInfo(requested, getModelInfo);
    for (const info of [httpInfo, wsInfo]) {
      assert.equal(info.provider, "codex");
      assert.equal(info.model, "gpt-6.1-sol");
    }
  });

  for (const suffix of ["", "-none", "-low", "-medium", "-high", "-xhigh"]) {
    test(`${prefix}gpt-5.5${suffix} preserves explicit effort and context`, async () => {
      const info = await getModelInfo(`${prefix}gpt-5.5${suffix}[1m]`);
      assert.equal(info.provider, "codex");
      assert.equal(info.model, `gpt-6.1-sol${suffix}`);
      assert.equal(info.extendedContext, true);
      // The translation stage passes the resolved model to the executor.
      const body = { model: info.model, reasoning: { effort: "high" } };
      const transformed = new CodexExecutor().transformRequest(info.model, body, true, {});
      assert.equal(transformed.model, "gpt-6.1-sol");
      assert.equal(transformed.reasoning.effort, suffix ? suffix.slice(1) : "high");
      assert.equal(body.model, info.model);
    });
  }
}

test("explicit other providers and distinct model names keep their routing", async () => {
  for (const model of [
    "openai/gpt-5.5",
    "other/gpt-5.5",
    "codex/gpt-5.5-pro",
    "codex/gpt-5.50",
    "codex/gpt-6.1-sol",
  ]) {
    const info = await getModelInfo(model);
    const [provider, expected] = model.split("/");
    assert.equal(info.provider, provider);
    assert.equal(info.model, expected);
  }
});

test("WebSocket prepare sends the successor base model and preserves suffix effort", async () => {
  for (const model of ["gpt-5.5", "cx/gpt-5.5-high", "codex/gpt-5.5-xhigh"]) {
    const result = await prepareWs(
      new Request("http://localhost/api/internal/codex-responses-ws", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-omniroute-ws-bridge-secret": process.env.OMNIROUTE_WS_BRIDGE_SECRET!,
        },
        body: JSON.stringify({
          action: "prepare",
          requestUrl: "/v1/responses",
          response: { model, reasoning: { effort: "low" }, input: "Hello" },
        }),
      })
    );
    const prepared = await result.json();
    assert.equal(result.status, 200, JSON.stringify(prepared));
    assert.equal(prepared.response.model, "gpt-6.1-sol");
    assert.equal(
      prepared.response.reasoning.effort,
      model.endsWith("-xhigh") ? "xhigh" : model.endsWith("-high") ? "high" : "low"
    );
    assert.equal(prepared.connectionId, connectionId);
  }
});
