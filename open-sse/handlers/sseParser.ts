import { recoverCompletedItemId, toResponseOutputIndex } from "./responsesItemId.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";

/**
 * Extract a provider error message from a buffered SSE stream that carries an
 * error-only chunk (`data: {"error":...}`) and no content chunks.
 *
 * Some executors always return `text/event-stream` even on failure (e.g. the
 * Devin/Windsurf CLI executors emit `data: {"error":{"message":"Devin CLI not
 * found..."}}`). Those chunks have no `choices`/Claude/Responses content, so the
 * content parsers (parseSSEToOpenAIResponse etc.) correctly return `null`. Without
 * this helper the caller would replace the real upstream error with a generic
 * "Invalid SSE response" 502, swallowing the actionable message (#3324).
 *
 * Provider-agnostic: matches any `data:` chunk that has an `error` field but no
 * `choices` array. The returned message is always run through sanitizeErrorMessage
 * so stack traces / absolute source paths never leak (Hard Rule #12). Returns
 * `null` when no error-only chunk is present (so valid-content streams are left
 * to the normal parsers).
 */
export function extractSSEErrorMessage(rawSSE: unknown): string | null {
  const lines = String(rawSSE || "").split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue; // Ignore malformed lines and keep scanning.
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;

    // A chunk with content (choices) is not an error-only chunk — defer to the
    // normal content parsers so the valid-SSE path is never short-circuited.
    if (Array.isArray(record.choices)) continue;

    const err = record.error;
    if (err == null) continue;

    const message = bufferedErrorText(err);

    const sanitized = sanitizeErrorMessage(message);
    if (sanitized) return sanitized;
  }

  return null;
}

/**
 * Convert OpenAI-style SSE chunks into a single non-streaming JSON response.
 * Used as a fallback when upstream returns text/event-stream for stream=false.
 */
function readSSEEvents(rawSSE) {
  const lines = String(rawSSE || "").split("\n");
  const events = [];
  let currentEvent = "";
  let currentData = [];

  const flush = () => {
    if (currentData.length === 0) {
      currentEvent = "";
      return;
    }

    const payload = currentData.join("\n").trim();
    currentData = [];
    if (!payload || payload === "[DONE]") {
      currentEvent = "";
      return;
    }

    try {
      const data = JSON.parse(payload);
      if (
        currentEvent &&
        data &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        typeof data.type !== "string"
      ) {
        data.type = currentEvent;
      }
      events.push({
        event: currentEvent || undefined,
        data,
      });
    } catch {
      // Ignore malformed SSE events and continue best-effort parsing.
    }

    currentEvent = "";
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") {
      flush();
      continue;
    }

    if (line.startsWith("event:")) {
      // Some relays omit the blank separator between Claude events. Flush the
      // previous event before accepting the next event name.
      if (currentData.length > 0) flush();
      currentEvent = line.slice(6).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      const dataLine = line.slice(5).trimStart();
      if (dataLine.trim() === "[DONE]") {
        flush();
        currentEvent = "";
        continue;
      }
      currentData.push(dataLine);
    }
  }

  flush();
  return events;
}

function toRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function toNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * Convert Claude-style SSE events into a single non-streaming message object.
 * Used when Claude-compatible upstreams stream even for stream=false.
 */
function startClaudeBlock(payload, blocks) {
  const index = toNumber(payload.index, blocks.size);
  const contentBlock = toRecord(payload.content_block);
  const blockType = toString(contentBlock.type);

  if (blockType === "thinking") {
    blocks.set(index, {
      type: "thinking",
      index,
      thinking: toString(contentBlock.thinking),
      signature: toString(contentBlock.signature) || undefined,
    });
  } else if (blockType === "tool_use") {
    blocks.set(index, {
      type: "tool_use",
      index,
      id: toString(contentBlock.id, `toolu_${Date.now()}_${index}`),
      name: toString(contentBlock.name),
      input: contentBlock.input ?? {},
      inputJson: "",
    });
  } else {
    blocks.set(index, {
      type: "text",
      index,
      text: toString(contentBlock.text),
    });
  }
}

function appendClaudeToolInput(index, existing, delta, blocks) {
  const toolUse =
    existing && existing.type === "tool_use"
      ? existing
      : {
          type: "tool_use",
          index,
          id: `toolu_${Date.now()}_${index}`,
          name: "",
          input: {},
          inputJson: "",
        };
  toolUse.inputJson += toString(delta.partial_json);
  blocks.set(index, toolUse);
}

function appendClaudeThinking(index, existing, delta, deltaType, blocks) {
  const isThinkingDelta = deltaType === "thinking_delta" || typeof delta.thinking === "string";
  const isSignatureDelta = deltaType === "signature_delta" || typeof delta.signature === "string";
  if (isThinkingDelta || isSignatureDelta) {
    const thinking =
      existing && existing.type === "thinking"
        ? existing
        : { type: "thinking", index, thinking: "", signature: undefined };
    if (isThinkingDelta) thinking.thinking += toString(delta.thinking);
    const signature = toString(delta.signature);
    if (signature) thinking.signature = `${thinking.signature || ""}${signature}`;
    blocks.set(index, thinking);
    return true;
  }

  return false;
}

function appendClaudeBlock(payload, blocks) {
  const index = toNumber(payload.index, 0);
  const delta = toRecord(payload.delta);
  const deltaType = toString(delta.type);
  const existing = blocks.get(index);

  if (deltaType === "input_json_delta") {
    appendClaudeToolInput(index, existing, delta, blocks);
    return;
  }
  if (appendClaudeThinking(index, existing, delta, deltaType, blocks)) return;
  const textBlock =
    existing && existing.type === "text"
      ? existing
      : {
          type: "text",
          index,
          text: "",
        };
  textBlock.text += toString(delta.text);
  blocks.set(index, textBlock);
}

export function parseSSEToClaudeResponse(rawSSE, fallbackModel) {
  const payloads = readSSEEvents(rawSSE)
    .map((event) => toRecord(event.data))
    .filter((payload) => Object.keys(payload).length > 0);

  if (payloads.length === 0) return null;

  const blocks = new Map();
  const usage = {};
  let messageId = "";
  let model = fallbackModel || "claude";
  let role = "assistant";
  let stopReason = "end_turn";
  let stopSequence = null;
  let sawClaudeEvent = false;

  for (const payload of payloads) {
    const eventType = toString(payload.type);
    if (eventType === "message_start") {
      sawClaudeEvent = true;
      const message = toRecord(payload.message);
      messageId = toString(message.id, messageId || `msg_${Date.now()}`);
      model = toString(message.model, model);
      role = toString(message.role, role);
      mergeClaudeUsage(usage, message.usage);
      continue;
    }

    if (eventType === "content_block_start") {
      sawClaudeEvent = true;
      startClaudeBlock(payload, blocks);
      continue;
    }
    if (eventType === "content_block_delta") {
      sawClaudeEvent = true;
      appendClaudeBlock(payload, blocks);
      continue;
    }

    if (eventType === "message_delta") {
      sawClaudeEvent = true;
      const delta = toRecord(payload.delta);
      stopReason = toString(delta.stop_reason, stopReason);
      stopSequence = toString(delta.stop_sequence, stopSequence);
      mergeClaudeUsage(usage, payload.usage);
      continue;
    }

    mergeClaudeUsage(usage, payload.usage);
  }

  if (!sawClaudeEvent) return null;

  const content = buildClaudeContent(blocks);

  return {
    id: messageId || `msg_${Date.now()}`,
    type: "message",
    role,
    model,
    content,
    stop_reason: stopReason,
    ...(stopSequence ? { stop_sequence: stopSequence } : {}),
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
  };
}

/**
 * Convert Responses API SSE events into a single non-streaming response object.
 * Expects events such as response.created / response.in_progress / response.completed.
 */
const RESPONSES_TERMINAL_EVENT_TYPES = new Set([
  "response.completed",
  "response.done",
  "response.cancelled",
  "response.canceled",
  "response.failed",
  "response.incomplete",
]);

function toIdString(value) {
  return value === null || value === undefined ? "" : String(value);
}

function cloneResponseItem(item) {
  const record = toRecord(item);
  return {
    ...record,
    id: record.id != null ? String(record.id) : record.id,
    call_id: record.call_id != null ? String(record.call_id) : record.call_id,
    ...(Array.isArray(record.content)
      ? {
          content: record.content.map((contentPart) => {
            const part = toRecord(contentPart);
            return { ...part };
          }),
        }
      : {}),
    ...(Array.isArray(record.summary)
      ? {
          summary: record.summary.map((summaryPart) => {
            const part = toRecord(summaryPart);
            return { ...part };
          }),
        }
      : {}),
  };
}

function ensureResponsesMessageItem(outputItems, outputIndex) {
  const existing = outputItems.get(outputIndex);
  if (existing?.type === "message") return existing;

  const next = {
    ...(existing && typeof existing === "object" ? existing : {}),
    id: existing?.id != null ? String(existing.id) : `msg_${Date.now()}_${outputIndex}`,
    type: "message",
    role: "assistant",
    content: Array.isArray(existing?.content)
      ? existing.content.map((contentPart) => ({ ...toRecord(contentPart) }))
      : [{ type: "output_text", annotations: [], text: "" }],
  };

  if (next.content.length === 0) {
    next.content.push({ type: "output_text", annotations: [], text: "" });
  }

  outputItems.set(outputIndex, next);
  return next;
}

function ensureResponsesReasoningItem(outputItems, outputIndex, itemId) {
  const existing = outputItems.get(outputIndex);
  if (existing?.type === "reasoning") return existing;

  const next = {
    ...(existing && typeof existing === "object" ? existing : {}),
    id:
      itemId ||
      (existing?.id != null ? String(existing.id) : null) ||
      `rs_${Date.now()}_${outputIndex}`,
    type: "reasoning",
    summary: Array.isArray(existing?.summary)
      ? existing.summary.map((summaryPart) => ({ ...toRecord(summaryPart) }))
      : [{ type: "summary_text", text: "" }],
  };

  if (next.summary.length === 0) {
    next.summary.push({ type: "summary_text", text: "" });
  }

  outputItems.set(outputIndex, next);
  return next;
}

function ensureResponsesFunctionCallItem(outputItems, outputIndex, itemId, callId, name) {
  const existing = outputItems.get(outputIndex);
  const normalizedItemId = toIdString(itemId);
  const normalizedCallId = toIdString(callId);
  const existingId = existing?.id != null ? String(existing.id) : "";
  const existingCallId = existing?.call_id != null ? String(existing.call_id) : "";

  if (existing?.type === "function_call") {
    updateResponsesFunctionCall(existing, normalizedCallId, name, normalizedItemId);
    return existing;
  }

  const next = createResponsesFunctionCall(
    existing,
    normalizedItemId,
    normalizedCallId,
    existingId,
    existingCallId,
    outputIndex,
    name
  );

  outputItems.set(outputIndex, next);
  return next;
}

function mergeResponseItems(existing, incoming) {
  const next = cloneResponseItem(incoming);
  if (!existing || typeof existing !== "object") return next;

  return {
    ...existing,
    ...next,
    ...(Array.isArray(next.content)
      ? {
          content: next.content,
        }
      : {}),
    ...(Array.isArray(next.summary)
      ? {
          summary: next.summary,
        }
      : {}),
  };
}

function readResponsesDataLines(rawSSE) {
  const lines = String(rawSSE || "").split("\n");
  const events = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      const record = toRecord(parsed);
      if (Object.keys(record).length > 0) {
        events.push(record);
      }
    } catch {
      // Ignore malformed lines and continue best-effort parsing.
    }
  }

  return events;
}

function addResponsesItem(evt, outputIndex, item, outputItems, completedItems) {
  outputItems.set(outputIndex, cloneResponseItem(item));
}

function completeResponsesItem(evt, outputIndex, item, outputItems, completedItems) {
  completedItems.set(outputIndex, item);
  const existing = outputItems.get(outputIndex);
  outputItems.set(outputIndex, mergeResponseItems(existing, item));
}

function appendResponsesText(evt, outputIndex, item, outputItems, completedItems) {
  const messageItem = ensureResponsesMessageItem(outputItems, outputIndex);
  const content = Array.isArray(messageItem.content) ? messageItem.content : [];
  const firstPart =
    content.length > 0 ? { ...toRecord(content[0]) } : { type: "output_text", annotations: [] };
  firstPart.type = firstPart.type || "output_text";
  firstPart.annotations = Array.isArray(firstPart.annotations) ? firstPart.annotations : [];
  firstPart.text = `${toString(firstPart.text)}${toString(evt.delta)}`;
  content[0] = firstPart;
  messageItem.content = content;
}

function finishResponsesText(evt, outputIndex, item, outputItems, completedItems) {
  const messageItem = ensureResponsesMessageItem(outputItems, outputIndex);
  const content = Array.isArray(messageItem.content) ? messageItem.content : [];
  const firstPart =
    content.length > 0 ? { ...toRecord(content[0]) } : { type: "output_text", annotations: [] };
  firstPart.type = firstPart.type || "output_text";
  firstPart.annotations = Array.isArray(firstPart.annotations) ? firstPart.annotations : [];
  firstPart.text = toString(evt.text, toString(firstPart.text));
  content[0] = firstPart;
  messageItem.content = content;
}

function appendResponsesReasoning(evt, outputIndex, item, outputItems, completedItems) {
  const reasoningItem = ensureResponsesReasoningItem(
    outputItems,
    outputIndex,
    toIdString(evt.item_id)
  );
  const summary = Array.isArray(reasoningItem.summary) ? reasoningItem.summary : [];
  const firstPart =
    summary.length > 0 ? { ...toRecord(summary[0]) } : { type: "summary_text", text: "" };
  firstPart.type = firstPart.type || "summary_text";
  firstPart.text = `${toString(firstPart.text)}${toString(evt.delta)}`;
  summary[0] = firstPart;
  reasoningItem.summary = summary;
}

function finishResponsesReasoning(evt, outputIndex, item, outputItems, completedItems) {
  const reasoningItem = ensureResponsesReasoningItem(
    outputItems,
    outputIndex,
    toIdString(evt.item_id)
  );
  const summary = Array.isArray(reasoningItem.summary) ? reasoningItem.summary : [];
  const firstPart =
    summary.length > 0 ? { ...toRecord(summary[0]) } : { type: "summary_text", text: "" };
  firstPart.type = firstPart.type || "summary_text";
  firstPart.text = toString(evt.text, toString(firstPart.text));
  summary[0] = firstPart;
  reasoningItem.summary = summary;
}

function appendResponsesArguments(evt, outputIndex, item, outputItems, completedItems) {
  const functionCallItem = ensureResponsesFunctionCallItem(
    outputItems,
    outputIndex,
    toIdString(evt.item_id),
    "",
    ""
  );
  functionCallItem.arguments = `${toString(functionCallItem.arguments)}${toString(evt.delta)}`;
}

function finishResponsesArguments(evt, outputIndex, item, outputItems, completedItems) {
  const functionCallItem = ensureResponsesFunctionCallItem(
    outputItems,
    outputIndex,
    toIdString(evt.item_id),
    "",
    ""
  );
  functionCallItem.arguments = toString(evt.arguments, toString(functionCallItem.arguments));
}

const RESPONSES_ITEM_HANDLERS = {
  "response.output_item.added": addResponsesItem,
  "response.output_item.done": completeResponsesItem,
  "response.output_text.delta": appendResponsesText,
  "response.output_text.done": finishResponsesText,
  "response.reasoning_summary_text.delta": appendResponsesReasoning,
  "response.reasoning_summary_text.done": finishResponsesReasoning,
  "response.function_call_arguments.delta": appendResponsesArguments,
  "response.function_call_arguments.done": finishResponsesArguments,
};

export function parseSSEToResponsesOutput(rawSSE, fallbackModel) {
  const events = readResponsesDataLines(rawSSE);

  if (events.length === 0) return null;

  let terminalResponse = null;
  let terminalEventType = "";
  let latestResponse = null;
  const outputItems = new Map();
  const completedItems = new Map<number, Record<string, unknown>>();

  for (const evt of events) {
    const eventType = toString(evt?.type);
    const outputIndex = toResponseOutputIndex(evt?.output_index);
    const item = toRecord(evt?.item);

    consumeIndexedResponsesItem(evt, eventType, outputIndex, item, outputItems, completedItems);

    if (RESPONSES_TERMINAL_EVENT_TYPES.has(eventType) && evt.response) {
      terminalResponse = evt.response;
      terminalEventType = eventType;
    }
    if (evt?.response && typeof evt.response === "object") {
      latestResponse = evt.response;
    } else if (evt?.object === "response") {
      latestResponse = evt;
    }
  }

  return buildBufferedResponsesOutput(
    terminalResponse,
    latestResponse,
    terminalEventType,
    outputItems,
    completedItems,
    fallbackModel
  );
}

function buildBufferedResponsesOutput(
  terminalResponse,
  latestResponse,
  terminalEventType,
  outputItems,
  completedItems,
  fallbackModel
) {
  const picked = terminalResponse || latestResponse;
  if (!picked || typeof picked !== "object") return null;
  const reconstructedOutput = [...outputItems.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => item)
    .filter((item) => item && typeof item === "object");
  const pickedOutput = Array.isArray(picked.output) ? picked.output : [];
  const chosenOutput = chooseBufferedResponsesOutput(pickedOutput, reconstructedOutput);
  const statusFallback = bufferedResponsesStatus(terminalEventType, terminalResponse);

  return {
    id: picked.id != null ? String(picked.id) : `resp_${Date.now()}`,
    object: picked.object || "response",
    model: picked.model || fallbackModel || "unknown",
    output: chosenOutput.map((item, index) => {
      const record = toRecord(item);
      return {
        ...record,
        id: recoverCompletedItemId(
          record,
          completedItems.get(index),
          chosenOutput === pickedOutput
        ),
        call_id: record.call_id != null ? String(record.call_id) : record.call_id,
      };
    }),
    usage: picked.usage || null,
    status: picked.status || statusFallback,
    ...bufferedResponsesDetails(picked),
    created_at: picked.created_at || Math.floor(Date.now() / 1000),
    metadata: picked.metadata || {},
  };
}

function bufferedResponsesStatus(terminalEventType, terminalResponse) {
  return terminalEventType === "response.cancelled"
    ? "cancelled"
    : terminalEventType === "response.canceled"
      ? "canceled"
      : terminalEventType === "response.failed"
        ? "failed"
        : terminalEventType === "response.incomplete"
          ? "incomplete"
          : terminalResponse
            ? "completed"
            : "in_progress";
}

function buildClaudeContent(blocks) {
  const tryParseJson = (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };
  const content = [];
  for (const block of [...blocks.values()].sort((a, b) => a.index - b.index)) {
    if (block.type === "text") {
      if (block.text) content.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "thinking") {
      appendClaudeThinkingContent(block, content);
      continue;
    }

    const input = block.inputJson.trim().length > 0 ? tryParseJson(block.inputJson) : block.input;
    content.push({ type: "tool_use", id: block.id, name: block.name, input });
  }

  return content;
}

function bufferedErrorText(err) {
  let message = "";
  if (typeof err === "string") {
    message = err;
  } else if (typeof err === "object" && !Array.isArray(err)) {
    const errRecord = err as Record<string, unknown>;
    if (typeof errRecord.message === "string") {
      message = errRecord.message;
    } else {
      message = JSON.stringify(err);
    }
  } else {
    message = String(err);
  }

  return message;
}

function mergeClaudeUsage(usage, incoming) {
  const usageRecord = toRecord(incoming);
  for (const [key, value] of Object.entries(usageRecord)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      usage[key] = value;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      usage[key] = { ...toRecord(usage[key]), ...toRecord(value) };
    } else if (typeof value === "string" && value.trim().length > 0) {
      usage[key] = value;
    }
  }
}

function updateResponsesFunctionCall(existing, normalizedCallId, name, normalizedItemId) {
  if (existing.call_id != null) existing.call_id = String(existing.call_id);
  if (existing.id != null) existing.id = String(existing.id);
  if (normalizedCallId && !existing.call_id) existing.call_id = normalizedCallId;
  if (name && !existing.name) existing.name = name;
  if (normalizedItemId && !existing.id) existing.id = normalizedItemId;
}

function chooseBufferedResponsesOutput(pickedOutput, reconstructedOutput) {
  // #3948 — A Responses-API terminal snapshot (`response.completed`) can carry a
  // non-empty `output` that LACKS the assistant message item (e.g. only a
  // `reasoning` item) even though the streamed `output_text` deltas reconstructed
  // a full message. Preferring such a textless terminal output drops the
  // assistant text → empty content on `stream:false` (n8n combo). When the
  // terminal output has no message item but the reconstructed delta output does,
  // use the reconstructed output (a superset carrying the message). The terminal
  // snapshot still wins whenever it already contains the message item.
  const outputHasMessage = (items: unknown[]) =>
    items.some((item) => toRecord(item).type === "message");
  return pickedOutput.length > 0 &&
    !outputHasMessage(pickedOutput) &&
    outputHasMessage(reconstructedOutput)
    ? reconstructedOutput
    : pickedOutput.length > 0
      ? pickedOutput
      : reconstructedOutput;
}

function appendClaudeThinkingContent(block, content) {
  const hasSignature = typeof block.signature === "string" && block.signature.length > 0;
  if (block.thinking || hasSignature) {
    content.push({
      type: "thinking",
      thinking: block.thinking || "",
      ...(hasSignature ? { signature: block.signature } : {}),
    });
  }
}

function consumeIndexedResponsesItem(
  evt,
  eventType,
  outputIndex,
  item,
  outputItems,
  completedItems
) {
  if (outputIndex !== null) {
    const handleItem = Object.hasOwn(RESPONSES_ITEM_HANDLERS, eventType)
      ? RESPONSES_ITEM_HANDLERS[eventType]
      : null;
    if (handleItem) handleItem(evt, outputIndex, item, outputItems, completedItems);
  }
}

function createResponsesFunctionCall(
  existing,
  normalizedItemId,
  normalizedCallId,
  existingId,
  existingCallId,
  outputIndex,
  name
) {
  return {
    ...(existing && typeof existing === "object" ? existing : {}),
    id:
      normalizedItemId || existingId || `fc_${normalizedCallId || `${Date.now()}_${outputIndex}`}`,
    type: "function_call",
    call_id: normalizedCallId || existingCallId || "",
    name: name || existing?.name || "",
    arguments: typeof existing?.arguments === "string" ? existing.arguments : "",
  };
}

function bufferedResponsesDetails(picked) {
  return {
    ...(picked.error != null ? { error: picked.error } : {}),
    ...(picked.incomplete_details && typeof picked.incomplete_details === "object"
      ? { incomplete_details: picked.incomplete_details }
      : {}),
  };
}
export { parseSSEToOpenAIResponse } from "./sseParserChat.ts";
