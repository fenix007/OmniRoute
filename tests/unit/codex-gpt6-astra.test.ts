import test from "node:test";
import assert from "node:assert/strict";

import { getModelsByProviderId } from "../../open-sse/config/providerModels.ts";
import { CodexExecutor } from "../../open-sse/executors/codex.ts";
import { getModelSpec } from "../../src/shared/constants/modelSpecs.ts";
import { getPricingForModel } from "../../src/shared/constants/pricing.ts";
import { resolveCodexGlobalFastServiceTier } from "../../src/lib/providers/codexFastTier.ts";

const ASTRA_IDS = [
  "gpt-6-astra",
  "gpt-6-astra-max",
  "gpt-6-astra-xhigh",
  "gpt-6-astra-high",
  "gpt-6-astra-medium",
  "gpt-6-astra-low",
];

test("Codex catalog exposes the GPT-6 Astra lineup with the live 272K window", () => {
  const models = getModelsByProviderId("codex");

  for (const modelId of ASTRA_IDS) {
    const model = models.find((entry) => entry.id === modelId);
    assert.ok(model, `codex must expose ${modelId}`);
    assert.equal(model.contextLength, 272000);
    assert.equal(model.maxInputTokens, 272000);
    assert.equal(model.maxOutputTokens, 128000);
    assert.equal(model.targetFormat, "openai-responses");
    assert.equal(model.toolCalling, true);
    assert.equal(model.supportsReasoning, true);
    assert.equal(model.supportsVision, true);
    assert.equal(model.supportsXHighEffort, true);
  }
});

test("Codex catalog exposes no ultra or none variant for GPT-6 Astra", () => {
  const models = getModelsByProviderId("codex");

  for (const unsupported of ["gpt-6-astra-ultra", "gpt-6-astra-none"]) {
    assert.equal(
      models.some((model) => model.id === unsupported),
      false,
      `${unsupported} is not a supported Astra effort`
    );
  }
});

test("OpenAI API catalog exposes GPT-6 Astra at the public 1.05M window", () => {
  const model = getModelsByProviderId("openai").find((entry) => entry.id === "gpt-6-astra");

  assert.ok(model, "openai must expose gpt-6-astra");
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

test("CodexExecutor clamps an ultra request for GPT-6 Astra down to max", () => {
  const executor = new CodexExecutor();
  const result = executor.transformRequest(
    "gpt-6-astra",
    { model: "gpt-6-astra", input: [], reasoning_effort: "ultra" },
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

test("GPT-6 Astra is Fast-tier eligible by default", () => {
  const resolved = resolveCodexGlobalFastServiceTier({ codexServiceTier: { enabled: true } });

  assert.ok(resolved.supportedModels.includes("gpt-6-astra"));
});
