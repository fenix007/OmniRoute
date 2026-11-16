import { appendToolCallArgumentDelta } from "../utils/toolCallArguments.ts";

function accumulateChatToolCall(tc, key, accumulatedToolCalls) {
  const existing = accumulatedToolCalls.get(key);
  const deltaArgs = typeof tc?.function?.arguments === "string" ? tc.function.arguments : "";

  if (!existing) {
    accumulatedToolCalls.set(key, createChatToolCall(tc, deltaArgs, accumulatedToolCalls.size));
  } else {
    updateChatToolIdentity(existing, tc);
    existing.function = existing.function || {};
    existing.function.arguments = appendToolCallArgumentDelta(
      existing.function.arguments,
      deltaArgs
    );
    accumulatedToolCalls.set(key, existing);
  }
}

function createChatToolCall(tc, deltaArgs, size) {
  return {
    id: tc?.id != null ? String(tc.id) : null,
    index: Number.isInteger(tc?.index) ? tc.index : size,
    type: tc?.type || "function",
    function: {
      name: tc?.function?.name || "unknown",
      arguments: deltaArgs,
    },
  };
}

function accumulateChatChunk(
  chunk,
  contentParts,
  reasoningParts,
  accumulatedToolCalls,
  getToolCallKey,
  state
) {
  const choice = chunk?.choices?.[0];
  const delta = choice?.delta || {};

  appendChatText(delta, contentParts, reasoningParts);

  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      accumulateChatToolCall(tc, getToolCallKey(tc), accumulatedToolCalls);
    }
  }

  if (choice?.finish_reason) {
    state.finishReason = choice.finish_reason;
  }
  if (chunk?.usage && typeof chunk.usage === "object") {
    state.usage = chunk.usage;
  }
}

export function parseSSEToOpenAIResponse(rawSSE, fallbackModel) {
  const chunks = readChatDataLines(rawSSE);
  if (chunks.length === 0) return null;

  const first = chunks[0];
  const contentParts = [];
  const reasoningParts = [];
  type AccumulatedToolCall = {
    id: string | null;
    index: number;
    type: string;
    function: { name: string; arguments: string };
  };

  const accumulatedToolCalls = new Map<string, AccumulatedToolCall>();
  let unknownToolCallSeq = 0;
  let finishReason = "stop";
  let usage = null;

  const getToolCallKey = (toolCall: Record<string, unknown>) => {
    if (Number.isInteger(toolCall?.index)) return `idx:${toolCall.index}`;
    if (toolCall?.id != null) return `id:${String(toolCall.id)}`;
    unknownToolCallSeq += 1;
    return `seq:${unknownToolCallSeq}`;
  };

  const state = { finishReason, usage };
  for (const chunk of chunks) {
    accumulateChatChunk(
      chunk,
      contentParts,
      reasoningParts,
      accumulatedToolCalls,
      getToolCallKey,
      state
    );
  }
  finishReason = state.finishReason;
  usage = state.usage;

  const joinedContent = contentParts.length > 0 ? contentParts.join("").trim() : "";
  const joinedReasoning = reasoningParts.length > 0 ? reasoningParts.join("").trim() : null;
  const message: Record<string, unknown> = {
    role: "assistant",
    content: joinedContent,
  };
  if (joinedReasoning) {
    message.reasoning_content = joinedReasoning;
  }

  const finalToolCalls = [...accumulatedToolCalls.values()].filter(Boolean).sort((a, b) => {
    const ai = Number.isInteger(a?.index) ? a.index : 0;
    const bi = Number.isInteger(b?.index) ? b.index : 0;
    return ai - bi;
  });
  if (finalToolCalls.length > 0) {
    finishReason = "tool_calls"; // T18 normalization
    message.tool_calls = finalToolCalls;
  }

  const result: Record<string, unknown> = {
    id: first.id != null ? String(first.id) : `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: first.created || Math.floor(Date.now() / 1000),
    model: first.model || fallbackModel || "unknown",
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
  };

  if (usage) {
    result.usage = usage;
  }

  return result;
}

function readChatDataLines(rawSSE) {
  const lines = String(rawSSE || "").split("\n");
  const chunks = [];
  let sawChoices = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      if (Array.isArray(parsed?.choices)) {
        sawChoices = true;
      }
      chunks.push(parsed);
    } catch {
      // Ignore malformed SSE lines and continue best-effort parsing.
    }
  }

  return sawChoices ? chunks : [];
}

function updateChatToolIdentity(existing, tc) {
  existing.id = existing.id || (tc?.id != null ? String(tc.id) : null);
  if (!Number.isInteger(existing.index) && Number.isInteger(tc?.index)) {
    existing.index = tc.index;
  }
  if (tc?.function?.name && !existing.function?.name) {
    existing.function = existing.function || {};
    existing.function.name = tc.function.name;
  }
}

function appendChatText(delta, contentParts, reasoningParts) {
  if (typeof delta.content === "string" && delta.content.length > 0) {
    contentParts.push(delta.content);
  }
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
    reasoningParts.push(delta.reasoning_content);
  }
  // Normalize `reasoning` alias (NVIDIA kimi-k2.5 etc.)
  if (
    typeof delta.reasoning === "string" &&
    delta.reasoning.length > 0 &&
    !delta.reasoning_content
  ) {
    reasoningParts.push(delta.reasoning);
  }
}
