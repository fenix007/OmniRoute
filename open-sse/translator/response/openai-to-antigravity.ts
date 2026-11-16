import { register } from "../registry.ts";
import { FORMATS } from "../formats.ts";

type AntigravityCandidate = {
  content: {
    role: string;
    parts: Array<Record<string, unknown>>;
  };
  finishReason?: string;
};

type AntigravityUsageMetadata = {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
};

// Convert OpenAI SSE chunk to Antigravity SSE format
// Real Antigravity format:
//   data: {"response":{"candidates":[{"content":{"role":"model","parts":[...]}, "finishReason":"STOP"}], "usageMetadata":{...}, "modelVersion":"...", "responseId":"..."}}
// Tool calls: OpenAI sends incremental args across chunks → accumulate and emit ONCE at finish
export function openaiToAntigravityResponse(chunk, state) {
  if (!chunk) return null;

  const choice = chunk.choices?.[0];
  if (!choice) {
    if (chunk.usage) {
      state._usage = chunk.usage;
    }
    return null;
  }

  const delta = choice.delta || {};
  const finishReason = choice.finish_reason;

  initializeAntigravityState(state, chunk);
  const parts = [];

  appendAntigravityText(delta, parts);

  if (delta.tool_calls) {
    accumulateAntigravityTools(delta.tool_calls, state._toolCallAccum);
    if (parts.length === 0 && !finishReason) return null;
  }
  if (finishReason) appendAntigravityTools(state._toolCallAccum, parts);

  // Skip empty non-finish chunks
  if (parts.length === 0 && !finishReason) return null;

  // Ensure at least empty text part on finish with no content
  if (parts.length === 0 && finishReason) {
    parts.push({ text: "" });
  }

  return buildAntigravityResponse(parts, finishReason, state, chunk);
}

function accumulateAntigravityTools(toolCalls, accumulators) {
  for (const tc of toolCalls) {
    const idx = tc.index ?? 0;
    if (!accumulators[idx]) {
      accumulators[idx] = { id: "", name: "", arguments: "" };
    }
    const accum = accumulators[idx];
    if (tc.id) accum.id = tc.id;
    if (tc.function?.name) accum.name += tc.function.name;
    if (tc.function?.arguments) accum.arguments += tc.function.arguments;
  }
}

function appendAntigravityTools(accumulators, parts) {
  const indices = Object.keys(accumulators);
  for (const idx of indices) {
    const accum = accumulators[idx];
    let args = {};
    try {
      args = JSON.parse(accum.arguments);
    } catch {
      /* empty */
    }
    parts.push({
      functionCall: {
        name: accum.name,
        args,
      },
    });
  }
}

function antigravityUsage(usage): AntigravityUsageMetadata {
  const metadata: AntigravityUsageMetadata = {
    promptTokenCount: usage.prompt_tokens || 0,
    candidatesTokenCount: usage.completion_tokens || 0,
    totalTokenCount: usage.total_tokens || 0,
  };
  if (usage.completion_tokens_details?.reasoning_tokens) {
    metadata.thoughtsTokenCount = usage.completion_tokens_details.reasoning_tokens;
  }
  if (usage.prompt_tokens_details?.cached_tokens) {
    metadata.cachedContentTokenCount = usage.prompt_tokens_details.cached_tokens;
  }

  return metadata;
}

// Register
register(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, null, openaiToAntigravityResponse);

function initializeAntigravityState(state, chunk) {
  // Init state
  if (!state._toolCallAccum) state._toolCallAccum = {};
  if (!state._responseId) state._responseId = chunk.id || `resp_${Date.now()}`;
  if (!state._modelVersion) state._modelVersion = chunk.model || "";
}

function buildAntigravityResponse(parts, finishReason, state, chunk) {
  // Build candidate
  const candidate: AntigravityCandidate = { content: { role: "model", parts } };

  // Finish reason mapping
  if (finishReason) {
    const reasonMap = {
      stop: "STOP",
      length: "MAX_TOKENS",
      tool_calls: "STOP",
      content_filter: "SAFETY",
    };
    candidate.finishReason = reasonMap[finishReason] || "STOP";
  }

  // Build response
  const response: {
    candidates: AntigravityCandidate[];
    modelVersion: string;
    responseId: string;
    usageMetadata?: AntigravityUsageMetadata;
  } = {
    candidates: [candidate],
    modelVersion: state._modelVersion,
    responseId: state._responseId,
  };

  const usage = chunk.usage || state._usage;
  if (usage) response.usageMetadata = antigravityUsage(usage);

  return { response };
}

function appendAntigravityText(delta, parts) {
  // Thinking/reasoning → thought part
  if (delta.reasoning_content) {
    parts.push({ thought: true, text: delta.reasoning_content });
  }

  // Text content
  if (delta.content) {
    parts.push({ text: delta.content });
  }
}
