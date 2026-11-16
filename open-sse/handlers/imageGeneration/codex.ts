import { sanitizeErrorMessage } from "../../utils/error.ts";
import { getCodexClientVersion, getCodexUserAgent } from "../../config/codexClient.ts";
import { saveImageErrorResult, saveImageSuccessResult } from "./callLogResult.ts";

/**
 * Codex image generation — translate GPT-Image-style /v1/images/generations
 * request into a /v1/responses call with the `image_generation` hosted tool,
 * parse the SSE stream, and return the base64 PNG in OpenAI image response shape.
 *
 * Requires ChatGPT OAuth credentials (Codex provider connection). The hosted
 * image_generation tool is only served upstream under ChatGPT auth; API-key
 * users will receive a 400 from OpenAI.
 */
type ImageCall = { b64: string; revisedPrompt: string | null };
type JsonRecord = Record<string, unknown>;

function parseImageEvent(payload: string): JsonRecord | null {
  try {
    const event = JSON.parse(payload);
    return event && typeof event === "object" && !Array.isArray(event) ? event : null;
  } catch {
    return null;
  }
}

function collectImageCalls(items: unknown[], target: ImageCall[]) {
  for (const value of items) {
    if (!value || typeof value !== "object") continue;
    const item = value as JsonRecord;
    if (item.type !== "image_generation_call") continue;
    const result = typeof item.result === "string" ? item.result : "";
    if (!result) continue;
    const revisedPrompt = typeof item.revised_prompt === "string" ? item.revised_prompt : null;
    target.push({ b64: result, revisedPrompt });
  }
}

export function extractImageGenerationCalls(sseText: string): ImageCall[] {
  const results: ImageCall[] = [];
  const terminalResults: ImageCall[] = [];
  const lines = String(sseText || "").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const evt = parseImageEvent(payload);
    if (!evt) continue;
    const items = imageEventItems(evt);
    const target = evt.type === "response.completed" ? terminalResults : results;
    collectImageCalls(items, target);
  }
  return results.length > 0 ? results : terminalResults;
}

type FailureState = {
  terminal: string | null;
  upstreamCode: string | null;
  sawDone: boolean;
  sawEmptyImageItem: boolean;
  sawImageItem: boolean;
  imageInTerminalOnly: boolean;
  sawRefusal: boolean;
};

function safeCode(value: unknown) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function imageFailureCode(event: JsonRecord, type: string, response: JsonRecord | undefined) {
  const error = (event.error ||
    response?.error ||
    (type === "error" ? event : null)) as JsonRecord | null;
  let code = safeCode(error?.code);
  if (type === "response.incomplete" && !code) {
    const details = response?.incomplete_details as JsonRecord | undefined;
    code = safeCode(details?.reason);
  }
  if (!code && typeof error?.message === "string" && /\boverloaded\b/i.test(error.message)) {
    code = "overloaded";
  }
  return code;
}

function hasImageRefusal(item: JsonRecord | undefined): boolean {
  return (
    item?.type === "message" &&
    Array.isArray(item.content) &&
    item.content.some(
      (part: unknown) =>
        part &&
        typeof part === "object" &&
        ["refusal", "output_refusal"].includes((part as JsonRecord).type as string)
    )
  );
}

function inspectImageOutput(output: unknown, state: FailureState) {
  if (!Array.isArray(output)) return;
  for (const outputItem of output) {
    if (!outputItem || typeof outputItem !== "object") continue;
    const finalItem = outputItem as JsonRecord;
    if (finalItem.type === "image_generation_call") {
      state.sawImageItem = true;
      state.imageInTerminalOnly ||=
        typeof finalItem.result === "string" && finalItem.result.length > 0;
    }
    state.sawRefusal ||= hasImageRefusal(finalItem);
  }
}

function inspectImageFailureEvent(event: JsonRecord, state: FailureState) {
  const type = typeof event.type === "string" ? event.type : "";
  const response = event.response as JsonRecord | undefined;
  const item = event.item as JsonRecord | undefined;
  const isTerminal = [
    "response.completed",
    "response.failed",
    "response.incomplete",
    "error",
  ].includes(type);
  if (isTerminal) state.upstreamCode = imageFailureCode(event, type, response);
  if (type === "response.output_item.done" && item?.type === "image_generation_call") {
    state.sawImageItem = true;
    state.sawEmptyImageItem = true;
  }
  inspectImageOutput(response?.output, state);
  state.sawRefusal ||= hasImageRefusal(item);
  if (isTerminal) state.terminal = type;
}

function imageFailureKind(state: FailureState): string {
  if (state.sawRefusal) return "refusal";
  if (state.imageInTerminalOnly) return "image_in_terminal_only";
  if (state.terminal === "response.failed" || state.terminal === "error") return "response_failed";
  if (state.terminal === "response.incomplete") return "response_incomplete";
  if (state.sawEmptyImageItem) return "empty_image_item";
  if (state.terminal === "response.completed") return "completed_no_image";
  return "no_terminal_event";
}

// Inspect only bounded metadata on the unsuccessful image path.
export function classifyCodexImageFailure(sseText: string): {
  kind: string;
  upstreamCode: string | null;
  sawDone: boolean;
  sawImageItem: boolean;
} {
  const state: FailureState = {
    terminal: null,
    upstreamCode: null,
    sawDone: false,
    sawEmptyImageItem: false,
    sawImageItem: false,
    imageInTerminalOnly: false,
    sawRefusal: false,
  };
  for (const line of String(sseText || "")
    .slice(-64 * 1024)
    .split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") {
      state.sawDone = true;
      continue;
    }
    const event = parseImageEvent(payload);
    if (event) inspectImageFailureEvent(event, state);
  }
  return {
    kind: imageFailureKind(state),
    upstreamCode: state.upstreamCode,
    sawDone: state.sawDone,
    sawImageItem: state.sawImageItem,
  };
}

// The image_generation hosted tool accepts { "auto" | "low" | "medium" | "high" }
// for `quality`. Legacy image clients often send "standard" / "hd". Map those values
// so OpenWebUI's quality dropdown doesn't silently get rejected upstream.
function mapLegacyImageQualityToImageTool(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "standard") return "medium";
  if (normalized === "hd") return "high";
  return normalized;
}

export async function handleCodexImageGeneration({
  model,
  provider,
  providerConfig,
  body,
  credentials,
  log,
  signal,
  deferFailureLog,
}) {
  const startTime = Date.now();
  const prompt = codexImagePrompt(body);
  if (!prompt.trim()) {
    return saveImageErrorResult({
      provider,
      model,
      connectionId: credentials?.connectionId,
      status: 400,
      startTime,
      error: "Prompt is required for Codex image generation",
    });
  }

  const { requestedCount, workspacePlan } = codexImageOptions(body, credentials);
  const deferRetryableFailureLog =
    deferFailureLog && requestedCount === 1 && workspacePlan === "k12";
  if (log && requestedCount > 1) {
    log.warn(
      "IMAGE",
      `Codex hosted image_generation returns one image per call; requested n=${requestedCount} will fan out in parallel`
    );
  }

  const token = credentials?.accessToken || credentials?.apiKey;
  if (!token) {
    return saveImageErrorResult({
      provider,
      model,
      connectionId: credentials?.connectionId,
      status: 401,
      startTime,
      error: "Codex credentials missing accessToken — reconnect the Codex provider",
    });
  }

  const { upstreamBody, headers } = buildCodexImageRequest(body, prompt, model, credentials, token);

  if (log) log.info("IMAGE", `${provider}/${model} (codex-responses)`);

  const imageContext = {
    provider,
    model,
    credentials,
    startTime,
    upstreamBody,
    headers,
    signal,
    providerConfig,
    log,
    deferRetryableFailureLog,
    workspacePlan,
  };

  const imageResults = await Promise.all(
    Array.from({ length: requestedCount }, () => fetchCodexImage(imageContext))
  );

  const collection = collectCodexImages(imageResults, body);
  if ("error" in collection) return saveImageErrorResult(collection.error);
  const { data } = collection;

  return saveImageSuccessResult({
    provider,
    model,
    connectionId: credentials?.connectionId,
    startTime,
    requestBody: upstreamBody,
    responseBody: { images_count: data.length },
    images: data,
  });
}

function buildCodexImageRequest(body, prompt, model, credentials, token) {
  const workspaceId =
    credentials?.providerSpecificData &&
    typeof credentials.providerSpecificData === "object" &&
    !Array.isArray(credentials.providerSpecificData)
      ? (credentials.providerSpecificData as Record<string, unknown>).workspaceId
      : undefined;

  // Forward size/quality from the GPT-Image-style body into the hosted tool so
  // OpenWebUI's size/quality selectors actually take effect. Everything else
  // (model, n, background, moderation, output_compression) is left to the
  // Codex backend's defaults — today that's `gpt-image-2`.
  const toolConfig: Record<string, unknown> = { type: "image_generation", output_format: "png" };
  if (typeof body.size === "string" && body.size.trim()) {
    toolConfig.size = body.size.trim();
  }
  if (typeof body.quality === "string" && body.quality.trim()) {
    toolConfig.quality = mapLegacyImageQualityToImageTool(body.quality.trim());
  }

  const upstreamBody: Record<string, unknown> = {
    model,
    instructions:
      "You must call the image_generation tool exactly once to fulfill the user's request. Do not add narration.",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
    tools: [toolConfig],
    stream: true,
    store: false,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${token}`,
    Version: getCodexClientVersion(),
    "User-Agent": getCodexUserAgent(),
    originator: "codex_cli_rs",
  };
  if (typeof workspaceId === "string" && workspaceId) {
    headers["chatgpt-account-id"] = workspaceId;
    headers["session_id"] = workspaceId;
  }

  return { upstreamBody, headers };
}

async function fetchCodexImage(context) {
  const {
    provider,
    model,
    credentials,
    startTime,
    upstreamBody,
    headers,
    signal,
    providerConfig,
    log,
    deferRetryableFailureLog,
    workspacePlan,
  } = context;
  const cancelled = () =>
    codexImageRequestError(context, {
      status: 499,
      error: "client disconnected: request_signal_aborted",
    });
  if (signal?.aborted) return cancelled();
  let response: Response;
  try {
    response = await fetch(providerConfig.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return cancelled();
    if (log) log.error("IMAGE", `${provider} fetch error: ${(err as Error).message}`);
    return codexImageRequestError(context, {
      status: 502,
      error: sanitizeErrorMessage(`Image provider error: ${(err as Error).message}`),
      deferLog: deferRetryableFailureLog,
    });
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch {
    if (signal?.aborted) return cancelled();
    return codexImageRequestError(context, {
      status: 502,
      error: "Image provider response read failed",
      deferLog: deferRetryableFailureLog,
    });
  }
  if (signal?.aborted) return cancelled();

  if (!response.ok) {
    const errorText = responseText;
    if (log) log.error("IMAGE", `${provider} error ${response.status}: ${errorText.slice(0, 200)}`);
    return codexImageRequestError(context, {
      status: response.status,
      error: errorText,
      deferLog: deferRetryableFailureLog && [500, 502, 503, 504].includes(response.status),
    });
  }

  return finishCodexImageResponse(response, responseText, {
    provider,
    model,
    credentials,
    startTime,
    upstreamBody,
    deferRetryableFailureLog,
    workspacePlan,
  });
}

function finishCodexImageResponse(
  response: Response,
  responseText: string,
  { provider, model, credentials, startTime, upstreamBody, deferRetryableFailureLog, workspacePlan }
) {
  const rawSSE = responseText;
  const items = extractImageGenerationCalls(rawSSE);
  if (items.length === 0) {
    const failure = classifyCodexImageFailure(rawSSE);
    const requestId = response.headers.get("x-request-id");
    const safeRequestId = requestId && /^[a-zA-Z0-9._-]{1,128}$/.test(requestId) ? requestId : null;
    return {
      ok: false as const,
      error: {
        provider,
        model,
        connectionId: credentials?.connectionId,
        status: 502,
        startTime,
        error: "Codex response ended without producing an image_generation_call",
        failureCode: "codex_image_no_result",
        failureKind: failure.kind,
        upstreamCode: failure.upstreamCode,
        deferLog: deferRetryableFailureLog,
        diagnostics: `plan=${workspacePlan};kind=${failure.kind};code=${failure.upstreamCode || "none"};done=${failure.sawDone ? 1 : 0};image_item=${failure.sawImageItem ? 1 : 0}${safeRequestId ? `;request_id=${safeRequestId}` : ""}`,
        requestBody: upstreamBody,
      },
    };
  }

  return { ok: true as const, items };
}

function collectCodexImages(imageResults, body) {
  const collected: Array<{ b64_json: string; revised_prompt?: string }> = [];
  for (const imageResult of imageResults) {
    if (!imageResult.ok) return { error: imageResult.error };
    for (const item of imageResult.items) {
      collected.push({
        b64_json: item.b64,
        ...(item.revisedPrompt ? { revised_prompt: item.revisedPrompt } : {}),
      });
    }
  }

  const wantsUrl = body.response_format !== "b64_json";
  const data = wantsUrl
    ? collected.map((item) => ({
        url: `data:image/png;base64,${item.b64_json}`,
        ...(item.revised_prompt ? { revised_prompt: item.revised_prompt } : {}),
      }))
    : collected;

  return { data };
}

function imageEventItems(evt: JsonRecord): unknown[] {
  const response = evt.response as JsonRecord | undefined;
  return evt.type === "response.output_item.done"
    ? [evt.item]
    : evt.type === "response.completed" && Array.isArray(response?.output)
      ? response.output
      : [];
}

function codexImageOptions(body, credentials) {
  const requestedCount =
    Number.isInteger(body.n) && (body.n as number) > 0 ? (body.n as number) : 1;
  const rawWorkspacePlan = credentials?.providerSpecificData?.workspacePlanType;
  const workspacePlan =
    typeof rawWorkspacePlan === "string" && /^[a-z0-9_-]{1,32}$/i.test(rawWorkspacePlan)
      ? rawWorkspacePlan.toLowerCase()
      : "unknown";
  return { requestedCount, workspacePlan };
}

function codexImageRequestError(context, details) {
  return {
    ok: false as const,
    error: {
      provider: context.provider,
      model: context.model,
      connectionId: context.credentials?.connectionId,
      startTime: context.startTime,
      ...details,
      requestBody: context.upstreamBody,
    },
  };
}

function codexImagePrompt(body): string {
  return typeof body.prompt === "string" ? body.prompt : "";
}
