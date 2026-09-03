import type { RegistryEntry } from "../../../shared.ts";

export const opencode_goProvider: RegistryEntry = {
  id: "opencode-go",
  alias: "opencode-go",
  format: "openai",
  executor: "opencode",
  baseUrl: "https://opencode.ai/zen/go/v1",
  // (#532) Key validation must hit the main zen endpoint (same key works for both tiers)
  testKeyBaseUrl: "https://opencode.ai/zen/v1",
  authType: "apikey",
  authHeader: "Authorization",
  authPrefix: "Bearer",
  defaultContextLength: 200000,
  models: [
    // Keep this list aligned with GET /zen/go/v1/models and the endpoint table
    // in the official OpenCode Go docs. Models without targetFormat use the
    // provider default (/chat/completions).
    { id: "glm-5.2", name: "GLM-5.2", supportsReasoning: true },
    { id: "glm-5.1", name: "GLM-5.1", supportsReasoning: true },
    { id: "glm-5", name: "GLM-5", supportsReasoning: true },
    { id: "glm-5.3", name: "GLM-5.3", supportsReasoning: true },
    {
      id: "glm-5.3-flash",
      name: "GLM-5.3 Flash",
      supportsReasoning: true,
      supportsVision: true,
    },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", supportsReasoning: true },
    { id: "kimi-k2.6", name: "Kimi K2.6", supportsReasoning: true },
    { id: "kimi-k2.5", name: "Kimi K2.5", supportsReasoning: true },
    { id: "kimi-k3", name: "Kimi K3", supportsReasoning: true },
    { id: "longcat-2.0", name: "LongCat 2.0", supportsReasoning: true },
    { id: "mimo-v2.5-pro", name: "MiMo-V2.5-Pro", supportsReasoning: true },
    { id: "mimo-v2.5", name: "MiMo-V2.5", supportsReasoning: true },
    { id: "mimo-v2-pro", name: "MiMo V2 Pro", supportsReasoning: true },
    { id: "mimo-v2-omni", name: "MiMo V2 Omni", supportsReasoning: true },
    // #3110: MiniMax M3 via OpenCode Go tier
    {
      id: "minimax-m3",
      name: "MiniMax M3",
      targetFormat: "claude",
      contextLength: 1048576,
      supportsVision: true,
    },
    { id: "minimax-m2.7", name: "MiniMax M2.7", targetFormat: "claude" },
    { id: "minimax-m2.5", name: "MiniMax M2.5", targetFormat: "claude" },
    // Issue #2292: Qwen models on opencode-go reject oa-compat format
    // ("Model qwen3.x-* is not supported for format oa-compat") — same
    // upstream behavior already declared for opencode-zen. Route them
    // through /messages with the Claude translator.
    // Issue #2822: These models are text-only — mark supportsVision: false
    // so combo routing skips them when the request contains image blocks,
    // preventing image content from reaching a vision-incapable upstream.
    { id: "qwen3.7-max", name: "Qwen3.7 Max", targetFormat: "claude", supportsVision: false },
    {
      id: "qwen3.7-plus",
      name: "Qwen3.7 Plus",
      targetFormat: "claude",
      supportsVision: false,
    },
    {
      id: "qwen3.8-flash",
      name: "Qwen3.8 Flash",
      targetFormat: "claude",
      supportsVision: false,
    },
    {
      id: "qwen3.8-max",
      name: "Qwen3.8 Max",
      targetFormat: "claude",
      supportsVision: false,
    },
    { id: "qwen3.6-plus", name: "Qwen3.6 Plus", targetFormat: "claude", supportsVision: false },
    { id: "qwen3.5-plus", name: "Qwen3.5 Plus", targetFormat: "claude", supportsVision: false },
    { id: "hy3", name: "Hunyuan3", contextLength: 256000, supportsReasoning: true },
    { id: "hy3-preview", name: "Hunyuan3 Preview" },
    { id: "hy4-preview", name: "Hunyuan4 Preview", supportsReasoning: true },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", supportsReasoning: true },
    // OpencodeExecutor rewrites these aliases to the canonical upstream id and injects reasoning_effort.
    { id: "deepseek-v4-pro-low", name: "DeepSeek V4 Pro (low effort)", supportsReasoning: true },
    {
      id: "deepseek-v4-pro-medium",
      name: "DeepSeek V4 Pro (medium effort)",
      supportsReasoning: true,
    },
    { id: "deepseek-v4-pro-high", name: "DeepSeek V4 Pro (high effort)", supportsReasoning: true },
    { id: "deepseek-v4-pro-max", name: "DeepSeek V4 Pro (max effort)", supportsReasoning: true },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", supportsReasoning: true },
    {
      id: "deepseek-v4-flash-vision-exp",
      name: "DeepSeek V4 Flash Vision Exp",
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      targetFormat: "openai-responses",
      contextLength: 1050000,
      maxOutputTokens: 128000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "grok-4.5",
      name: "Grok 4.5",
      targetFormat: "openai-responses",
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "grok-4.6",
      name: "Grok 4.6",
      targetFormat: "openai-responses",
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "muse-spark-1.2-contributor",
      name: "Muse Spark 1.2 Contributor",
      targetFormat: "openai-responses",
      contextLength: 1048576,
      maxOutputTokens: 131072,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "muse-spark-1.3-contributor",
      name: "Muse Spark 1.3 Contributor",
      targetFormat: "openai-responses",
      contextLength: 1048576,
      maxOutputTokens: 131072,
      supportsReasoning: true,
      supportsVision: true,
    },
  ],
};
