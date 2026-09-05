import test from "node:test";
import assert from "node:assert/strict";

import { getModelsByProviderId } from "../../open-sse/config/providerModels.ts";
import { CodexExecutor } from "../../open-sse/executors/codex.ts";
import { getModelSpec } from "../../src/shared/constants/modelSpecs.ts";
import { getPricingForModel } from "../../src/shared/constants/pricing.ts";
import { resolveCodexGlobalFastServiceTier } from "../../src/lib/providers/codexFastTier.ts";
import { getCodexFastCostMultiplier } from "../../src/lib/usage/costCalculator.ts";
import {
  getCodexClientVersion,
  getCodexDefaultHeaders,
} from "../../open-sse/config/codexClient.ts";
import { getReasoningVariantBaseModelId } from "../../src/lib/vscode/reasoningMetadata.ts";

const ASTRA_IDS = [
  "gpt-6-astra",
  "gpt-6-astra-ultra",
  "gpt-6-astra-max",
  "gpt-6-astra-xhigh",
  "gpt-6-astra-high",
  "gpt-6-astra-medium",
  "gpt-6-astra-low",
];

test("Codex catalog exposes the GPT-6 Astra lineup at the usable 872K window", () => {
  const models = getModelsByProviderId("codex");

  for (const modelId of ASTRA_IDS) {
    const model = models.find((entry) => entry.id === modelId);
    assert.ok(model, `codex must expose ${modelId}`);
    assert.equal(model.contextLength, 872000);
    assert.equal(model.maxInputTokens, 872000);
    assert.equal(model.maxOutputTokens, 128000);
    assert.equal(model.targetFormat, "openai-responses");
    assert.equal(model.toolCalling, true);
    assert.equal(model.supportsReasoning, true);
    assert.equal(model.supportsVision, true);
    assert.equal(model.supportsXHighEffort, true);
  }
});

test("Codex catalog exposes no none variant for GPT-6 Astra", () => {
  const models = getModelsByProviderId("codex");

  assert.equal(
    models.some((model) => model.id === "gpt-6-astra-none"),
    false,
    "none is not a supported Astra effort"
  );
});

test("OpenAI API catalog exposes GPT-6 Astra at the public 1.05M window", () => {
  const model = getModelsByProviderId("openai").find((entry) => entry.id === "gpt-6-astra");

  assert.ok(model, "openai must expose gpt-6-astra");
  assert.ok(model.unsupportedParams?.includes("temperature"));
  assert.equal(model.contextLength, 1050000);
  assert.equal(model.maxInputTokens, 922000);
  assert.equal(model.maxOutputTokens, 128000);
  assert.equal(model.supportsVision, true);

  const spec = getModelSpec("gpt-6-astra");
  assert.equal(spec?.contextWindow, 1050000);
  assert.equal(spec?.maxOutputTokens, 128000);
});

test("CodexExecutor splits the GPT-6 Astra max alias off the model id", () => {
  const executor = new CodexExecutor();
  const result = executor.transformRequest(
    "gpt-6-astra-max",
    { model: "gpt-6-astra-max", input: [] },
    false,
    { requestEndpointPath: "/responses" }
  );

  assert.equal(result.model, "gpt-6-astra");
  assert.equal(result.reasoning.effort, "max");
});

test("CodexExecutor preserves an explicit max effort for GPT-6 Astra", () => {
  const executor = new CodexExecutor();
  const result = executor.transformRequest(
    "gpt-6-astra",
    { model: "gpt-6-astra", input: [], reasoning_effort: "max" },
    false,
    { requestEndpointPath: "/responses" }
  );

  assert.equal(result.model, "gpt-6-astra");
  assert.equal(result.reasoning.effort, "max");
  assert.equal(result.reasoning_effort, undefined);
});

test("CodexExecutor maps the GPT-6 Astra ultra alias to max wire effort", () => {
  const executor = new CodexExecutor();
  const result = executor.transformRequest(
    "gpt-6-astra-ultra",
    { model: "gpt-6-astra-ultra", input: [] },
    false,
    { requestEndpointPath: "/responses" }
  );

  assert.equal(result.model, "gpt-6-astra");
  assert.equal(result.reasoning.effort, "max");
});

test("GPT-6 Astra pricing is wired for both the Codex and OpenAI catalogs", () => {
  const expected = { input: 10, cached: 1, cache_creation: 12.5, output: 50 };

  for (const modelId of ASTRA_IDS) {
    const pricing = getPricingForModel("cx", modelId);
    assert.ok(pricing, `missing codex pricing for ${modelId}`);
    assert.equal(pricing.input, expected.input, `${modelId} input`);
    assert.equal(pricing.cached, expected.cached, `${modelId} cached`);
    assert.equal(pricing.cache_creation, expected.cache_creation, `${modelId} cache creation`);
    assert.equal(pricing.output, expected.output, `${modelId} output`);
  }

  const apiPricing = getPricingForModel("openai", "gpt-6-astra");
  assert.ok(apiPricing, "missing openai pricing for gpt-6-astra");
  assert.equal(apiPricing.input, expected.input);
  assert.equal(apiPricing.output, expected.output);
});

test("VS Code discovery splits Astra's extended effort aliases off the base id", () => {
  // Without this the alias survives as the base id and discovery expands it again
  // into invalid variants such as `gpt-6-astra-max-high`.
  assert.equal(getReasoningVariantBaseModelId("gpt-6-astra-max"), "gpt-6-astra");
  assert.equal(getReasoningVariantBaseModelId("gpt-6-astra-ultra"), "gpt-6-astra");
  assert.equal(getReasoningVariantBaseModelId("cx/gpt-6-astra-max"), "cx/gpt-6-astra");
  assert.equal(getReasoningVariantBaseModelId("gpt-6-astra-high"), "gpt-6-astra");
  assert.equal(getReasoningVariantBaseModelId("gpt-6-astra"), "gpt-6-astra");
  // The GPT-5.6 family keeps its existing behaviour.
  assert.equal(getReasoningVariantBaseModelId("gpt-5.6-sol-ultra"), "gpt-5.6-sol");
});

test("Codex identifies as a client version Astra accepts", () => {
  // Astra rejects older clients with HTTP 400 "requires a newer version of Codex"
  // (upstream issue #12761), so the advertised identity gates the whole model.
  assert.equal(getCodexClientVersion(), "0.153.4");
  assert.equal(getCodexDefaultHeaders().Version, "0.153.4");
});

test("Codex Fast bills GPT-6 Astra at the 2.5x multiplier", () => {
  assert.equal(getCodexFastCostMultiplier("cx", "gpt-6-astra", "priority"), 2.5);
  assert.equal(getCodexFastCostMultiplier("cx", "gpt-6-astra-max", "fast"), 2.5);
  assert.equal(getCodexFastCostMultiplier("cx", "gpt-6-astra", "default"), 1);
});

test("GPT-6 Astra is Fast-tier eligible by default", () => {
  const resolved = resolveCodexGlobalFastServiceTier({ codexServiceTier: { enabled: true } });

  assert.ok(resolved.supportedModels.includes("gpt-6-astra"));
});
