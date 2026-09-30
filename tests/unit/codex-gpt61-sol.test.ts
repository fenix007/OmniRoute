import test from "node:test";
import assert from "node:assert/strict";
import {
  getModelsByProviderId,
  getModelTargetFormat,
} from "../../open-sse/config/providerModels.ts";
import { CodexExecutor } from "../../open-sse/executors/codex.ts";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import { getCodexUpstreamModel } from "../../open-sse/config/codexModels.ts";
import { getModelInfoCore, parseModel } from "../../open-sse/services/model.ts";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses/toResponses.ts";
import { getModelSpec } from "../../src/shared/constants/modelSpecs.ts";
import { getPricingForModel } from "../../src/shared/constants/pricing.ts";
import {
  computeCostFromPricing,
  getCodexFastCostMultiplier,
} from "../../src/lib/usage/costCalculator.ts";
import { resolveCodexGlobalFastServiceTier } from "../../src/lib/providers/codexFastTier.ts";
import {
  getDefaultReasoningEffort,
  getReasoningEffortValues,
  getReasoningVariantBaseModelId,
} from "../../src/lib/vscode/reasoningMetadata.ts";
import { providerModelMutationSchema } from "../../src/shared/validation/schemas/provider.ts";
import { normalizeCodexModelsResponse } from "../../src/app/api/providers/[id]/models/discovery/codex.ts";

const MODEL = "gpt-6.1-sol";
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const IDS = [MODEL, ...EFFORTS.map((effort) => `${MODEL}-${effort}`)];

test.after(async () => {
  const { resetDbInstance } = await import("../../src/lib/db/core.ts");
  resetDbInstance();
});

type ResponsesBody = Record<string, unknown> & {
  reasoning: { effort: string; summary?: string };
  tools: { name: string }[];
};

function transform(model: string, body: Record<string, unknown> = {}, providerSpecificData = {}) {
  return new CodexExecutor().transformRequest(model, { model, input: [], ...body }, true, {
    requestEndpointPath: "/responses",
    providerSpecificData,
  }) as ResponsesBody;
}

test("Sol has provider-specific context limits and routes tool requests through Responses", async () => {
  const catalog = getModelsByProviderId("codex");
  assert.deepEqual(
    catalog.filter((m) => m.id.startsWith(MODEL)).map((m) => m.id),
    IDS
  );
  for (const id of IDS) {
    const entry = catalog.find((m) => m.id === id);
    assert.equal(entry?.contextLength, 872000);
    assert.equal(entry?.maxOutputTokens, 128000);
    assert.equal(entry?.toolCalling, true);
    assert.equal(entry?.supportsVision, true);
    assert.equal(getModelTargetFormat("cx", id), "openai-responses");
    assert.equal((await getModelInfoCore(id, {})).provider, "codex");
    assert.equal(getCodexUpstreamModel(id), MODEL, "account eligibility uses the wire model");
  }
  const api = getModelsByProviderId("openai").find((m) => m.id === MODEL);
  assert.equal(api?.contextLength, 1050000);
  assert.equal(api?.maxOutputTokens, 128000);
  assert.ok(api?.unsupportedParams?.includes("temperature"));
  assert.equal(getModelSpec(`openai/${MODEL}`)?.contextWindow, 1050000);
  assert.equal(getModelTargetFormat("openai", MODEL), "openai-responses");
  assert.equal(
    new DefaultExecutor("openai").buildUrl(MODEL, true),
    "https://api.openai.com/v1/responses"
  );
  assert.equal(parseModel(`openai/${MODEL}`).provider, "openai");
  assert.equal((await getModelInfoCore(MODEL, { [MODEL]: `openai/${MODEL}` })).provider, "openai");
});

test("Sol aliases override injected effort and keep max on native and translated requests", () => {
  for (const effort of EFFORTS) {
    const result = transform(`${MODEL}-${effort}`, {
      reasoning: { effort: "medium", summary: "detailed" },
    });
    assert.equal(result.model, MODEL);
    assert.equal(result.reasoning.effort, effort === "ultra" ? "max" : effort);
    assert.equal(result.reasoning.summary, "detailed");
  }
  assert.equal(transform(MODEL, { reasoning: { effort: "max" } }).reasoning.effort, "max");
  const translated = openaiToOpenAIResponsesRequest(
    MODEL,
    {
      model: MODEL,
      messages: [{ role: "user", content: "test" }],
      reasoning_effort: "max",
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    },
    true,
    {}
  ) as ResponsesBody;
  assert.equal(translated.reasoning.effort, "max");
  assert.equal(translated.tools[0].name, "lookup");
});

test("Sol defaults to low while preserving explicit request and connection preferences", () => {
  assert.equal(transform(MODEL).reasoning.effort, "low");
  assert.equal(transform(MODEL, { reasoning_effort: "high" }).reasoning.effort, "high");
  assert.equal(
    transform(MODEL, {}, { requestDefaults: { reasoningEffort: "xhigh" } }).reasoning.effort,
    "xhigh"
  );
  assert.equal(transform("gpt-6-sol").reasoning.effort, "medium");
});

test("Sol VS Code metadata exposes supported efforts without generating nested suffixes", () => {
  const model = { id: `cx/${MODEL}`, owned_by: "codex", capabilities: { reasoning: true } };
  assert.deepEqual(getReasoningEffortValues(model), EFFORTS);
  assert.equal(getDefaultReasoningEffort(model), "low");
  for (const effort of ["max", "ultra"]) {
    assert.equal(getReasoningVariantBaseModelId(`cx/${MODEL}-${effort}`), `cx/${MODEL}`);
    assert.equal(getDefaultReasoningEffort({ ...model, id: `cx/${MODEL}-${effort}` }), effort);
  }
});

test("Sol prices cached input independently from GPT-6 Sol and makes Fast eligible", () => {
  for (const id of IDS) {
    const pricing = getPricingForModel("cx", id);
    assert.equal(pricing?.input, 2);
    assert.equal(pricing?.cached, 0.1);
    assert.equal(pricing?.output, 10);
    assert.equal(pricing?.cache_creation, undefined);
    assert.equal(getCodexFastCostMultiplier("cx", id, "priority"), 2);
    assert.equal(getCodexFastCostMultiplier("codex", id, "fast"), 2);
    assert.equal(getCodexFastCostMultiplier("codex", id, "default"), 1);
  }
  assert.equal(getPricingForModel("openai", MODEL)?.cache_creation, 2.5);
  assert.equal(getPricingForModel("cx", "gpt-6-sol")?.cached, 0.2);
  assert.ok(
    resolveCodexGlobalFastServiceTier({
      codexServiceTier: { enabled: true },
    }).supportedModels.includes(MODEL)
  );
});

test("Sol cost counts cached input and reasoning-inclusive output once", () => {
  const tokens = { input: 100000, cacheRead: 50000, output: 2000, reasoning: 1000 };
  const pricing = getPricingForModel("cx", MODEL);
  for (const provider of ["cx", "codex", "openai"]) {
    const cost = computeCostFromPricing(pricing, tokens, { provider, model: MODEL });
    assert.ok(Math.abs(cost - 0.125) < 1e-10, `${provider}: ${cost}`);
  }
  const fast = computeCostFromPricing(pricing, tokens, {
    provider: "cx",
    model: `${MODEL}-max`,
    serviceTier: "priority",
  });
  assert.ok(Math.abs(fast - 0.25) < 1e-10);
  // Other providers retain the fork's existing separate-reasoning accounting.
  const existing = computeCostFromPricing(pricing, tokens, { provider: "custom", model: MODEL });
  assert.ok(Math.abs(existing - 0.135) < 1e-10);
});

test("discovered Sol Responses endpoints pass import validation and unknown endpoints fail", () => {
  const discovered = normalizeCodexModelsResponse({ models: [{ slug: MODEL }] })[0];
  const parsed = providerModelMutationSchema.parse({
    provider: "codex",
    modelId: MODEL,
    apiFormat: "responses",
    supportedEndpoints: discovered.supportedEndpoints,
  });
  assert.deepEqual(parsed.supportedEndpoints, ["responses"]);
  assert.equal(
    providerModelMutationSchema.safeParse({
      provider: "codex",
      modelId: MODEL,
      supportedEndpoints: ["arbitrary-endpoint"],
    }).success,
    false
  );
});

test("Sol streams tool events and retains Ultra parallel calls with the updated client identity", async (t) => {
  const executor = new CodexExecutor();
  const captured: { headers: Headers; body: Record<string, unknown> }[] = [];
  const sse = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_sol","object":"response","status":"in_progress"}}\n\n',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_sol","type":"function_call","call_id":"call_sol","name":"lookup","arguments":"{}"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_sol","status":"completed","output":[{"type":"function_call","call_id":"call_sol","name":"lookup","arguments":"{}"}]}}\n\n',
  ].join("");
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    captured.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  });
  for (const effort of ["ultra", "high"]) {
    const model = `${MODEL}-${effort}`;
    const result = await executor.execute({
      model,
      stream: true,
      credentials: { accessToken: "test-token" },
      clientHeaders: {
        "X-OpenAI-Internal-Codex-Responses-Lite": "true",
        Version: "0.157.0",
        "User-Agent": "codex-tui/0.157.0 (Ubuntu 24.4.0; x86_64)",
      },
      body: {
        _nativeCodexPassthrough: true,
        model,
        input: [{ role: "user", content: "test" }],
        parallel_tool_calls: true,
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      },
    });
    assert.equal(result.response.status, 200);
    const output = await result.response.text();
    assert.match(output, /response.completed/);
    assert.match(output, /call_sol/);
    const sent = captured.at(-1)!;
    assert.equal(sent.headers.get("version"), "0.159.2");
    assert.match(sent.headers.get("user-agent") || "", /0\.159\.2/);
    assert.equal(sent.body.model, MODEL);
    assert.equal(sent.body.parallel_tool_calls, effort === "ultra");
    assert.equal((sent.body.tools as { name: string }[])[0].name, "lookup");
  }
});
