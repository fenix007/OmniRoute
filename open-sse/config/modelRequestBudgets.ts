/**
 * Request budgets for models whose normal response latency intentionally exceeds
 * the global interactive-request defaults.
 */

export const PERPLEXITY_DEEP_RESEARCH_BUDGET_MS = 15 * 60 * 1000;

export function hasModelRequestBudget(provider: string, model: string | null | undefined): boolean {
  return provider === "perplexity-web" && model === "pplx-deep-research";
}

export function resolveModelRequestBudgetMs(
  provider: string,
  model: string | null | undefined,
  fallbackMs: number
): number {
  if (hasModelRequestBudget(provider, model)) {
    return PERPLEXITY_DEEP_RESEARCH_BUDGET_MS;
  }
  return fallbackMs;
}
