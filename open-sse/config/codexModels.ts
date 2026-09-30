// Shared wire-model identity for dispatch and per-account model eligibility.
// Ordered list of effort levels from lowest to highest
export const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type EffortLevel = (typeof EFFORT_ORDER)[number];
const STANDARD_EFFORT_SUFFIXES = ["none", "low", "medium", "high", "xhigh"] as const;
const GPT_5_6_MAX_ALIAS_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
export const GPT_5_6_ULTRA_ALIAS_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra"]);
// GPT-6 Astra takes both alias suffixes. `max` and `ultra` are not part of
// STANDARD_EFFORT_SUFFIXES, so without this set neither would ever split off the
// model id. `ultra` is an OmniRoute-side tier that goes out as wire effort `max`
// while keeping parallel tool calls for sub-agent delegation.
export const GPT_6_ALIAS_MODELS = new Set(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]);

export function splitCodexReasoningSuffix(model: unknown): {
  baseModel: string;
  effort: EffortLevel | null;
} {
  const modelId = typeof model === "string" ? model : "";
  const gpt56AliasMatch = /^(gpt-5\.6-(?:sol|terra|luna))-(max|ultra)$/.exec(modelId);
  if (gpt56AliasMatch) {
    const [, baseModel, alias] = gpt56AliasMatch;
    const supportedModels =
      alias === "ultra" ? GPT_5_6_ULTRA_ALIAS_MODELS : GPT_5_6_MAX_ALIAS_MODELS;
    if (supportedModels.has(baseModel)) {
      return { baseModel, effort: alias as EffortLevel };
    }
  }

  const gpt6AliasMatch = /^(gpt-6-(?:astra|sol|luna))-(max|ultra)$/.exec(modelId);
  if (gpt6AliasMatch) {
    const [, baseModel, alias] = gpt6AliasMatch;
    if (GPT_6_ALIAS_MODELS.has(baseModel) && !(baseModel === "gpt-6-luna" && alias === "ultra")) {
      return { baseModel, effort: alias as EffortLevel };
    }
  }

  for (const level of STANDARD_EFFORT_SUFFIXES) {
    if (modelId.endsWith(`-${level}`)) {
      return {
        baseModel: modelId.slice(0, -`-${level}`.length),
        effort: level,
      };
    }
  }
  return { baseModel: modelId, effort: null };
}

export function getCodexUpstreamModel(model: unknown): string {
  return splitCodexReasoningSuffix(model).baseModel;
}
