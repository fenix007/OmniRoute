/**
 * chatCore client usage buffer/estimate (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Extracted from handleChatCore's non-streaming success path: add a buffer to response usage for
 * CLI-oriented formats and filter it for the client format. Responses API usage remains raw so
 * non-stream JSON matches the provider's terminal event. If the provider returned no usage block,
 * fall back to estimating from the serialized content length. Mutates
 * `translatedResponse.usage` in place while preserving the original fallback estimation behavior.
 */
import {
  addBufferToUsage as defaultAddBuffer,
  filterUsageForFormat as defaultFilterUsage,
  estimateUsage as defaultEstimateUsage,
} from "../../utils/usageTracking.ts";
import { FORMATS } from "../../translator/formats.ts";

type ResponseLike =
  | {
      usage?: unknown;
      choices?: Array<{ message?: { content?: unknown } }>;
    }
  | null
  | undefined;

export interface ClientUsageBufferDeps {
  addBufferToUsage: typeof defaultAddBuffer;
  filterUsageForFormat: typeof defaultFilterUsage;
  estimateUsage: typeof defaultEstimateUsage;
}

const DEFAULT_DEPS: ClientUsageBufferDeps = {
  addBufferToUsage: defaultAddBuffer,
  filterUsageForFormat: defaultFilterUsage,
  estimateUsage: defaultEstimateUsage,
};

function isResponsesFormat(format: unknown): boolean {
  return format === FORMATS.OPENAI_RESPONSES || format === FORMATS.OPENAI_RESPONSE;
}

export function applyClientUsageBuffer(
  translatedResponse: ResponseLike,
  body: unknown,
  clientResponseFormat: unknown,
  deps: ClientUsageBufferDeps = DEFAULT_DEPS
): void {
  // Keep Responses API usage raw; other formats retain the CLI safety buffer.
  if (translatedResponse?.usage) {
    const usage = isResponsesFormat(clientResponseFormat)
      ? translatedResponse.usage
      : deps.addBufferToUsage(translatedResponse.usage);
    translatedResponse.usage = deps.filterUsageForFormat(usage, clientResponseFormat);
  } else {
    // Fallback: estimate usage when provider returned no usage block
    const contentLength = JSON.stringify(
      translatedResponse?.choices?.[0]?.message?.content || ""
    ).length;
    if (contentLength > 0) {
      const estimated = deps.estimateUsage(body, contentLength, clientResponseFormat);
      translatedResponse.usage = deps.filterUsageForFormat(estimated, clientResponseFormat);
    }
  }
}
