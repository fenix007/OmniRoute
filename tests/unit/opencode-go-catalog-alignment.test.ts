import test from "node:test";
import assert from "node:assert/strict";

const { getModelTargetFormat } = await import("../../open-sse/config/providerModels.ts");
const { opencode_goProvider } =
  await import("../../open-sse/config/providers/registry/opencode/go/index.ts");

const LIVE_MODEL_PROTOCOLS = {
  "deepseek-v4-flash": "openai",
  "deepseek-v4-flash-vision-exp": "openai",
  "deepseek-v4-pro": "openai",
  "glm-5": "openai",
  "glm-5.1": "openai",
  "glm-5.2": "openai",
  "glm-5.3": "openai",
  "glm-5.3-flash": "openai",
  "gpt-5.6-luna": "openai-responses",
  "grok-4.5": "openai-responses",
  "grok-4.6": "openai-responses",
  hy3: "openai",
  "hy3-preview": "openai",
  "hy4-preview": "openai",
  "kimi-k2.5": "openai",
  "kimi-k2.6": "openai",
  "kimi-k2.7-code": "openai",
  "kimi-k3": "openai",
  "longcat-2.0": "openai",
  "mimo-v2-omni": "openai",
  "mimo-v2-pro": "openai",
  "mimo-v2.5": "openai",
  "mimo-v2.5-pro": "openai",
  "minimax-m2.5": "claude",
  "minimax-m2.7": "claude",
  "minimax-m3": "claude",
  "muse-spark-1.2-contributor": "openai-responses",
  "muse-spark-1.3-contributor": "openai-responses",
  "qwen3.5-plus": "claude",
  "qwen3.6-plus": "claude",
  "qwen3.7-max": "claude",
  "qwen3.7-plus": "claude",
  "qwen3.8-flash": "claude",
  "qwen3.8-max": "claude",
} as const;

test("opencode-go catalog contains every live upstream model exactly once", () => {
  const ids = (opencode_goProvider.models ?? []).map((model) => model.id);
  assert.equal(new Set(ids).size, ids.length, "catalog contains duplicate model ids");

  for (const modelId of Object.keys(LIVE_MODEL_PROTOCOLS)) {
    assert.ok(ids.includes(modelId), `missing live OpenCode Go model: ${modelId}`);
  }
});

test("opencode-go live models use the documented endpoint protocol", () => {
  for (const [modelId, expectedFormat] of Object.entries(LIVE_MODEL_PROTOCOLS)) {
    assert.equal(getModelTargetFormat("opencode-go", modelId) ?? "openai", expectedFormat, modelId);
  }
});

test("opencode-go family fallback protects dynamically discovered successor models", () => {
  assert.equal(getModelTargetFormat("opencode-go", "gpt-future"), "openai-responses");
  assert.equal(getModelTargetFormat("opencode-go", "grok-future"), "openai-responses");
  assert.equal(getModelTargetFormat("opencode-go", "muse-spark-future"), "openai-responses");
  assert.equal(getModelTargetFormat("opencode-go", "minimax-future"), "claude");
  assert.equal(getModelTargetFormat("opencode-go", "qwen3.future"), "claude");
  assert.equal(getModelTargetFormat("opencode-go", "glm-future"), null);

  assert.equal(getModelTargetFormat("blackbox", "grok-future"), null);
  assert.equal(getModelTargetFormat("blackbox", "qwen3.future"), null);
});
