import "../_setup/isolateDataDir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { PerplexityWebExecutor } from "../../open-sse/executors/perplexity-web.ts";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.ts";

// ─── Test: Executor registration ────────────────────────────────────────────

test("PerplexityWebExecutor is registered in executor index", () => {
  assert.ok(hasSpecializedExecutor("perplexity-web"));
  assert.ok(hasSpecializedExecutor("pplx-web"));
  const executor = getExecutor("perplexity-web");
  assert.ok(executor instanceof PerplexityWebExecutor);
});

test("PerplexityWebExecutor alias resolves to same type", () => {
  const a = getExecutor("perplexity-web");
  const b = getExecutor("pplx-web");
  assert.ok(a instanceof PerplexityWebExecutor);
  assert.ok(b instanceof PerplexityWebExecutor);
});

// ─── Test: Provider registry ────────────────────────────────────────────────

test("Provider registry: perplexity-web is registered with correct models", async () => {
  const { PROVIDER_MODELS } = await import("../../open-sse/config/providerModels.ts");

  const models = PROVIDER_MODELS["pplx-web"];
  assert.ok(models, "pplx-web should be in PROVIDER_MODELS");
  assert.ok(models.length === 14, `Expected 14 models, got ${models.length}`);

  const modelIds = models.map((m) => m.id);
  assert.ok(modelIds.includes("pplx-auto"));
  assert.ok(modelIds.includes("pplx-gpt"));
  assert.ok(modelIds.includes("pplx-gpt-5.4"));
  assert.ok(modelIds.includes("pplx-sonnet"));
  assert.ok(modelIds.includes("pplx-opus"));
  assert.ok(modelIds.includes("pplx-gemini"));
  assert.ok(modelIds.includes("pplx-nemotron"));
  assert.ok(modelIds.includes("pplx-sonar"));
  assert.ok(modelIds.includes("pplx-kimi"));
  assert.ok(modelIds.includes("pplx-glm"));
  assert.ok(modelIds.includes("pplx-deep-research"));
  assert.ok(modelIds.includes("pplx-gpt-5.6-terra"));
  assert.ok(modelIds.includes("pplx-grok-4.6"));
});

test("Provider registry: every advertised perplexity-web model has an explicit internal mapping", async () => {
  const { PROVIDER_MODELS } = await import("../../open-sse/config/providerModels.ts");
  const { MODEL_MAP } = await import("../../open-sse/executors/perplexity-web/protocol.ts");

  const missing = PROVIDER_MODELS["pplx-web"].filter((model) => !MODEL_MAP[model.id]);
  assert.deepEqual(
    missing.map((model) => model.id),
    [],
    "all advertised Perplexity Web models should map to an explicit model_preference"
  );
});
