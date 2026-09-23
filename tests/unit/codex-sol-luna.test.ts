import test from "node:test";
import assert from "node:assert/strict";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.ts";
import { CodexExecutor } from "../../open-sse/executors/codex.ts";
import { resolveCodexAccountId } from "../../open-sse/utils/codexAccount.ts";
import { getCodexClientVersionFromHeaders } from "../../open-sse/config/codexClient.ts";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses/toResponses.ts";
import { CODEX_NATIVE_UNPREFIXED_MODELS } from "../../open-sse/services/model.ts";
import { getReasoningVariantBaseModelId } from "../../src/lib/vscode/reasoningMetadata.ts";
import { getPricingForModel } from "../../src/shared/constants/pricing.ts";
import {
  fetchCodexDiscoveryModels,
  normalizeCodexModelsResponse,
} from "../../src/app/api/providers/[id]/models/discovery/codex.ts";

const token = (accountId: unknown) =>
  `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.signature`;

test("Sol and Luna expose supported aliases and preserve native reasoning", () => {
  const executor = new CodexExecutor();
  const catalog = getModelsByProviderId("codex");
  for (const family of ["sol", "luna"]) {
    const model = `gpt-6-${family}`;
    const efforts = [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      ...(family === "sol" ? ["ultra"] : []),
    ];
    for (const suffix of ["", ...efforts.map((effort) => `-${effort}`)]) {
      const entry = catalog.find((item) => item.id === model + suffix);
      assert.equal(entry?.contextLength, 872000);
      assert.equal(CODEX_NATIVE_UNPREFIXED_MODELS.has(model + suffix), true);
      assert.ok(getPricingForModel("cx", model + suffix));
    }
    for (const effort of efforts) {
      const result = executor.transformRequest(
        `${model}-${effort}`,
        { model: `${model}-${effort}`, input: [] },
        true,
        { requestEndpointPath: "/responses" }
      );
      assert.equal(result.model, model);
      assert.equal(result.reasoning.effort, effort === "ultra" ? "max" : effort);
    }
    assert.equal(getReasoningVariantBaseModelId(`${model}-max`), model);
    const translated = openaiToOpenAIResponsesRequest(
      model,
      { model, messages: [{ role: "user", content: "test" }], reasoning_effort: "max" },
      true,
      {}
    );
    assert.equal(translated.reasoning.effort, "max");
  }
  assert.equal(
    catalog.some((item) => item.id === "gpt-6-luna-ultra"),
    false
  );
});

test("discovery retains object and string reasoning levels without malformed entries", () => {
  const models = normalizeCodexModelsResponse({
    models: [
      {
        slug: "gpt-6-sol",
        supported_reasoning_levels: [
          { effort: "low" },
          "high",
          { effort: "ultra" },
          null,
          1,
          { value: "max" },
          { effort: "" },
        ],
      },
    ],
  });
  assert.deepEqual(models[0].supportedThinkingEfforts, ["low", "high", "ultra"]);
});

test("executor and discovery bind the same token account over stale saved workspace", async () => {
  const accessToken = token("account-current");
  const providerSpecificData = { workspaceId: "org-stale" };
  assert.equal(
    new CodexExecutor().buildHeaders({ accessToken, providerSpecificData }, true)[
      "chatgpt-account-id"
    ],
    "account-current"
  );
  let accountHeader: string | undefined;
  await fetchCodexDiscoveryModels({
    accessToken,
    providerSpecificData,
    fetchImpl: async (_url, init) => {
      accountHeader = init.headers["chatgpt-account-id"];
      return Response.json({ models: [{ slug: "gpt-6-luna" }] });
    },
  });
  assert.equal(accountHeader, "account-current");
  for (const accessToken of [null, "opaque", "a.invalid.b", token("bad\r\nheader"), token(123)]) {
    assert.equal(resolveCodexAccountId(accessToken, providerSpecificData), "org-stale");
  }
  assert.equal(resolveCodexAccountId(null, { workspaceId: "bad\r\nheader" }), null);
});

test("caller version passes through with safe pinned fallback", () => {
  assert.equal(
    getCodexClientVersionFromHeaders({ "User-Agent": "codex_cli_rs/0.156.1 (Mac OS)" }),
    "0.156.1"
  );
  assert.equal(getCodexClientVersionFromHeaders({ version: "bad\r\nheader" }), null);
  const executor = new CodexExecutor();
  assert.equal(
    executor.buildHeaders({ accessToken: "opaque" }, true, { version: "0.157.0" }).Version,
    "0.157.0"
  );
  assert.equal(executor.buildHeaders({ accessToken: "opaque" }, true).Version, "0.156.1");
});
