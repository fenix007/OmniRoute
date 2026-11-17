import test from "node:test";
import assert from "node:assert/strict";
import {
  getModelsByProviderId,
  getModelTargetFormat,
} from "../../open-sse/config/providerModels.ts";
import { getCodexUpstreamModel } from "../../open-sse/config/codexModels.ts";
import { CodexExecutor, buildCodexRoutingHint } from "../../open-sse/executors/codex.ts";
import { getModelInfoCore } from "../../open-sse/services/model.ts";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses/toResponses.ts";
import {
  getDefaultReasoningEffort,
  getReasoningEffortValues,
  getReasoningVariantBaseModelId,
} from "../../src/lib/vscode/reasoningMetadata.ts";
import { getPricingForModel } from "../../src/shared/constants/pricing.ts";
import {
  computeCostFromPricing,
  getCodexFastCostMultiplier,
} from "../../src/lib/usage/costCalculator.ts";
import { resolveCodexGlobalFastServiceTier } from "../../src/lib/providers/codexFastTier.ts";

const MODEL = "gpt-6.2-sol";
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const IDS = [MODEL, ...EFFORTS.map((effort) => `${MODEL}-${effort}`)];

test.after(async () => {
  const { resetDbInstance } = await import("../../src/lib/db/core.ts");
  resetDbInstance();
});

function transform(model: string, body: Record<string, unknown> = {}, providerSpecificData = {}) {
  return new CodexExecutor().transformRequest(model, { model, input: [], ...body }, true, {
    requestEndpointPath: "/responses",
    providerSpecificData,
  });
}

test("GPT-6.2 Sol exposes the usable Codex context and infers Codex for every effort alias", async () => {
  // The current Codex OAuth catalog reports max_context_window=872000 and
  // supports low/medium/high/xhigh/max/ultra, with low as its default.
  const models = getModelsByProviderId("codex");
  assert.deepEqual(
    models.filter((entry) => entry.id.startsWith(MODEL)).map((entry) => entry.id),
    IDS
  );
  for (const id of IDS) {
    const entry = models.find((candidate) => candidate.id === id);
    assert.equal(entry?.contextLength, 872000);
    assert.equal(entry?.maxInputTokens, 872000);
    assert.equal(entry?.toolCalling, true);
    assert.equal(entry?.supportsVision, true);
    assert.equal(entry?.supportsReasoning, true);
    assert.equal(getModelTargetFormat("cx", id), "openai-responses");
    assert.equal((await getModelInfoCore(id, {})).provider, "codex");
    assert.equal(getCodexUpstreamModel(id), MODEL);
    assert.equal(buildCodexRoutingHint(id, { accessToken: "test-token" }), `model=${MODEL}`);
  }
});

test("GPT-6.2 Sol aliases preserve their selected effort and use the base wire model", () => {
  for (const effort of EFFORTS) {
    const result = transform(`${MODEL}-${effort}`, {
      reasoning: { effort: "medium", summary: "detailed" },
    });
    assert.equal(result.model, MODEL);
    assert.equal(result.reasoning.effort, effort === "ultra" ? "max" : effort);
    assert.equal(result.reasoning.summary, "detailed");
  }
  assert.equal(transform(MODEL, { reasoning: { effort: "max" } }).reasoning.effort, "max");
});

test("GPT-6.2 Sol defaults to low and preserves explicit request and connection preferences", () => {
  assert.equal(transform(MODEL).reasoning.effort, "low");
  assert.equal(transform(MODEL, { reasoning_effort: "high" }).reasoning.effort, "high");
  assert.equal(
    transform(MODEL, {}, { requestDefaults: { reasoningEffort: "xhigh" } }).reasoning.effort,
    "xhigh"
  );
  assert.equal(transform("gpt-6-sol").reasoning.effort, "medium");
});

test("GPT-6.2 Sol translation keeps max effort and function tools on Responses", () => {
  for (const model of [MODEL, `cx/${MODEL}`, `codex/${MODEL}-max`]) {
    const result = openaiToOpenAIResponsesRequest(
      model,
      {
        model,
        messages: [{ role: "user", content: "test" }],
        reasoning_effort: "max",
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      },
      true,
      {}
    );
    assert.equal(result.reasoning.effort, "max");
    assert.equal(result.tools[0].name, "lookup");
  }
});

test("GPT-6.2 Sol discovery exposes supported efforts without nested variant suffixes", () => {
  const model = { id: `cx/${MODEL}`, owned_by: "codex", capabilities: { reasoning: true } };
  assert.deepEqual(getReasoningEffortValues(model), EFFORTS);
  assert.equal(getDefaultReasoningEffort(model), "low");
  for (const effort of EFFORTS) {
    const id = `cx/${MODEL}-${effort}`;
    assert.equal(getReasoningVariantBaseModelId(id), `cx/${MODEL}`);
    assert.equal(getDefaultReasoningEffort({ ...model, id }), effort);
  }
});

test("GPT-6.2 Sol prices every Codex alias with cached input and enables Fast at 2x", () => {
  for (const id of IDS) {
    const pricing = getPricingForModel("cx", id);
    assert.equal(pricing?.input, 2);
    assert.equal(pricing?.cached, 0.1);
    assert.equal(pricing?.output, 10);
    assert.equal(pricing?.reasoning, 10);
    assert.equal(pricing?.cache_creation, undefined);
    for (const provider of ["cx", "codex"]) {
      assert.equal(getCodexFastCostMultiplier(provider, id, "priority"), 2);
      assert.equal(getCodexFastCostMultiplier(provider, id, "fast"), 2);
      assert.equal(getCodexFastCostMultiplier(provider, id, "default"), 1);
    }
  }
  assert.ok(
    resolveCodexGlobalFastServiceTier({
      codexServiceTier: { enabled: true },
    }).supportedModels.includes(MODEL)
  );
});

test("GPT-6.2 Sol cost counts cached input and reasoning-inclusive output once", () => {
  const tokens = { input: 100000, cacheRead: 50000, output: 2000, reasoning: 1000 };
  const pricing = getPricingForModel("cx", MODEL);
  for (const provider of ["cx", "codex"]) {
    for (const model of IDS) {
      const standard = computeCostFromPricing(pricing, tokens, { provider, model });
      assert.ok(Math.abs(standard - 0.125) < 1e-10, `${provider}/${model}: ${standard}`);
      const fast = computeCostFromPricing(pricing, tokens, {
        provider,
        model,
        serviceTier: "priority",
      });
      assert.ok(Math.abs(fast - 0.25) < 1e-10, `${provider}/${model} Fast: ${fast}`);
    }
  }
  const existing = computeCostFromPricing(pricing, tokens, { provider: "custom", model: MODEL });
  assert.ok(Math.abs(existing - 0.135) < 1e-10);
});

test("GPT-6.2 Sol Ultra retains parallel delegation while Responses Lite limits other efforts", async (t) => {
  const captured: Record<string, unknown>[] = [];
  const sse = [
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_sol62","type":"function_call","call_id":"call_sol62","name":"lookup","arguments":"{}"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_sol62","status":"completed","output":[{"type":"function_call","call_id":"call_sol62","name":"lookup","arguments":"{}"}]}}\n\n',
  ].join("");
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    captured.push(JSON.parse(String(init.body)));
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  });
  for (const effort of ["ultra", "high"]) {
    const model = `${MODEL}-${effort}`;
    const result = await new CodexExecutor().execute({
      model,
      stream: true,
      credentials: { accessToken: "test-token" },
      clientHeaders: { "X-OpenAI-Internal-Codex-Responses-Lite": "true" },
      body: {
        _nativeCodexPassthrough: true,
        model,
        input: [{ role: "user", content: "test" }],
        parallel_tool_calls: true,
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      },
    });
    assert.equal(result.response.status, 200);
    assert.match(await result.response.text(), /call_sol62/);
    const sent = captured.at(-1)!;
    assert.equal(sent.model, MODEL);
    assert.equal(sent.parallel_tool_calls, effort === "ultra");
    assert.equal((sent.tools as { name: string }[])[0].name, "lookup");
  }
});
