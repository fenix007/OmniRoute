import { getPendingById } from "@/lib/usage/usageHistory";
import { sanitizeErrorMessage } from "./error.ts";

type JsonRecord = Record<string, unknown>;

type HeaderInput =
  | Headers
  | Record<string, unknown>
  | { entries?: () => IterableIterator<[string, string]> }
  | null
  | undefined;

export type RequestPipelinePayloads = {
  clientRawRequest?: JsonRecord;
  openaiRequest?: JsonRecord;
  providerRequest?: JsonRecord;
  providerResponse?: JsonRecord;
  clientResponse?: JsonRecord;
  error?: JsonRecord;
  streamChunks?: {
    provider?: string[];
    openai?: string[];
    client?: string[];
  };
};

type RequestLogger = {
  sessionPath: null;
  logClientRawRequest: (endpoint: unknown, body: unknown, headers?: HeaderInput) => void;
  logOpenAIRequest: (body: unknown) => void;
  logTargetRequest: (url: unknown, headers: HeaderInput, body: unknown) => void;
  logProviderResponse: (
    status: unknown,
    statusText: unknown,
    headers: HeaderInput,
    body: unknown
  ) => void;
  appendProviderChunk: (chunk: string) => void;
  appendOpenAIChunk: (chunk: string) => void;
  logConvertedResponse: (body: unknown) => void;
  appendConvertedChunk: (chunk: string) => void;
  logError: (error: unknown, requestBody?: unknown) => void;
  getPipelinePayloads: () => RequestPipelinePayloads | null;
};

type RequestLoggerOptions = {
  enabled?: boolean;
  captureStreamChunks?: boolean;
  maxStreamChunkBytes?: number;
  maxStreamChunkItems?: number;
  requestId?: string | null;
  model?: string;
  provider?: string;
  connectionId?: string | null;
};

const DEFAULT_MAX_STREAM_CHUNK_BYTES = 128 * 1024;
const DEFAULT_MAX_STREAM_CHUNK_ITEMS = 10_240;
const MAX_LOG_STRING_LENGTH = 64 * 1024;
export const MAX_LOG_ARRAY_ITEMS = 24;
const MAX_LOG_OBJECT_KEYS = 80;

function maskSensitiveHeaders(headers: HeaderInput): Record<string, unknown> {
  if (!headers) return {};

  const headerEntries =
    typeof (headers as Headers).entries === "function"
      ? Object.fromEntries((headers as Headers).entries())
      : { ...(headers as Record<string, unknown>) };

  const masked = { ...headerEntries };
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token"];

  for (const key of Object.keys(masked)) {
    const lowerKey = key.toLowerCase();
    // Whitelist x-ratelimit- headers from redaction
    if (lowerKey.startsWith("x-ratelimit-")) {
      continue;
    }
    const compactKey = lowerKey.replace(/[^a-z0-9]/g, "");
    if (
      !compactKey.includes("apikey") &&
      !sensitiveKeys.some((candidate) => lowerKey.includes(candidate))
    ) {
      continue;
    }

    const value = masked[key];
    if (typeof value === "string" && value.length > 20) {
      masked[key] = `${value.slice(0, 10)}...${value.slice(-5)}`;
    } else if (value) {
      masked[key] = "[REDACTED]";
    }
  }

  return masked;
}

function createEmptyStreamChunks() {
  return {
    provider: [] as string[],
    openai: [] as string[],
    client: [] as string[],
  };
}

function truncateLogString(value: string, maxLength = MAX_LOG_STRING_LENGTH): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.floor(maxLength / 2))}\n[...truncated ${value.length - maxLength} chars...]\n${value.slice(-Math.ceil(maxLength / 2))}`;
}

/** Total per-payload bounds also cover exempt tool arrays and wide nested schemas. */
export const MAX_LOG_PAYLOAD_CHARS = 256 * 1024;
export const MAX_LOG_PAYLOAD_NODES = 4096;

/**
 * Clone for logging. Keep complete small tool inventories, and the tail of other
 * arrays, while sharing one string/node budget across the entire payload.
 */
export function cloneBoundedForLog(value: unknown, depth = 0, key: string | null = null): unknown {
  let remainingChars = MAX_LOG_PAYLOAD_CHARS;
  let remainingNodes = MAX_LOG_PAYLOAD_NODES;
  const exhausted = () => remainingChars <= 0 || remainingNodes <= 0;
  const clone = (input: unknown, currentDepth: number, field: string | null): unknown => {
    if (exhausted()) return "[LogPayloadLimit]";
    remainingNodes--;
    if (input === null || input === undefined) return input;
    if (typeof input === "string") {
      const result = truncateLogString(input, Math.min(MAX_LOG_STRING_LENGTH, remainingChars));
      remainingChars -= result.length;
      return result;
    }
    if (typeof input !== "object") return input;
    if (currentDepth >= 6) return "[MaxDepth]";

    if (Array.isArray(input)) {
      const shouldTruncate = field !== "tools" && input.length > MAX_LOG_ARRAY_ITEMS;
      const source = shouldTruncate ? input.slice(-MAX_LOG_ARRAY_ITEMS) : input;
      const mapped: unknown[] = [];
      for (const item of source) {
        if (exhausted()) {
          mapped.push({ _omniroute_truncated_payload: true, originalLength: input.length });
          break;
        }
        mapped.push(clone(item, currentDepth + 1, null));
      }
      if (shouldTruncate) {
        mapped.unshift({
          _omniroute_truncated_array: true,
          originalLength: input.length,
          retainedTailItems: MAX_LOG_ARRAY_ITEMS,
        });
      }
      return mapped;
    }

    const result: JsonRecord = {};
    let processedKeys = 0;
    let totalKeys = 0;
    // Avoid materializing all values from arbitrarily wide objects.
    for (const k in input as JsonRecord) {
      if (!Object.hasOwn(input, k)) continue;
      totalKeys++;
      if (processedKeys >= MAX_LOG_OBJECT_KEYS) continue;
      if (exhausted()) {
        result._omniroute_truncated_payload = true;
        break;
      }
      // Object keys consume memory too, and may themselves be oversized.
      if (k.length > remainingChars) {
        result._omniroute_truncated_payload = true;
        break;
      }
      remainingChars -= k.length;
      result[k] = clone((input as JsonRecord)[k], currentDepth + 1, k);
      processedKeys++;
    }
    if (totalKeys > MAX_LOG_OBJECT_KEYS) {
      result._omniroute_truncated_keys = totalKeys - MAX_LOG_OBJECT_KEYS;
    }
    return result;
  };
  return clone(value, depth, key);
}

function appendBoundedChunk(
  chunks: string[],
  bytes: { value: number; truncated: boolean },
  chunk: string,
  maxBytes: number,
  maxItems = DEFAULT_MAX_STREAM_CHUNK_ITEMS
) {
  if (typeof chunk !== "string" || chunk.length === 0) {
    return;
  }
  if (chunks.length >= maxItems) {
    bytes.truncated = true;
    chunks[maxItems - 1] = `[stream chunk log truncated after ${maxItems} chunks]`;
    return;
  }
  if (bytes.value >= maxBytes) {
    bytes.truncated = true;
    return;
  }

  const remaining = maxBytes - bytes.value;
  if (chunk.length <= remaining) {
    chunks.push(chunk);
    bytes.value += chunk.length;
    return;
  }

  chunks.push(chunk.slice(0, remaining));
  if (chunks.length < maxItems) {
    chunks.push(`[stream chunk log truncated after ${maxBytes} bytes]`);
  }
  bytes.value = maxBytes;
  bytes.truncated = true;
}

function hasOwnValues(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && Object.keys(value as JsonRecord).length > 0);
}

function compactPipelinePayloads(
  payloads: RequestPipelinePayloads
): RequestPipelinePayloads | null {
  const result: RequestPipelinePayloads = {};

  for (const [key, value] of Object.entries(payloads)) {
    if (value === null || value === undefined) {
      continue;
    }

    if (key === "streamChunks" && value && typeof value === "object") {
      const chunkRecord = value as Record<string, unknown>;
      const compactedChunks = Object.fromEntries(
        Object.entries(chunkRecord).filter(
          ([, chunkValue]) => Array.isArray(chunkValue) && chunkValue.length > 0
        )
      );
      if (Object.keys(compactedChunks).length > 0) {
        result.streamChunks = compactedChunks;
      }
      continue;
    }

    result[key as keyof RequestPipelinePayloads] = value;
  }

  return hasOwnValues(result) ? result : null;
}
function makeStreamChunkMethods(options: RequestLoggerOptions, captureChunks: boolean) {
  const streamChunks = createEmptyStreamChunks();
  const streamChunkBytes = {
    provider: { value: 0, truncated: false },
    openai: { value: 0, truncated: false },
    client: { value: 0, truncated: false },
  };
  const maxBytes =
    Number.isInteger(options.maxStreamChunkBytes) && Number(options.maxStreamChunkBytes) > 0
      ? Number(options.maxStreamChunkBytes)
      : DEFAULT_MAX_STREAM_CHUNK_BYTES;
  const maxItems =
    Number.isInteger(options.maxStreamChunkItems) && Number(options.maxStreamChunkItems) > 0
      ? Number(options.maxStreamChunkItems)
      : DEFAULT_MAX_STREAM_CHUNK_ITEMS;
  let pendingPushed = false;

  const push = () => {
    if (pendingPushed) return;
    if (!options.requestId && (!options.connectionId || !options.model)) return;
    pendingPushed = true;
    try {
      const pending = getPendingById();
      const exactEntry = options.requestId ? pending.get(options.requestId) : null;
      if (exactEntry) {
        exactEntry.streamChunks = { ...streamChunks };
        return;
      }

      for (const entry of pending.values()) {
        if (
          entry?.connectionId === options.connectionId &&
          entry?.model === options.model &&
          entry?.provider === (options.provider || "")
        ) {
          entry.streamChunks = { ...streamChunks };
          return;
        }
      }
    } catch (e) {
      // Do not allow logging failures to disrupt request handling
      try {
        console.warn("[requestLogger] updatePendingRequestStreamChunks failed:", e);
      } catch {}
    }
  };

  const append = (arr: string[], bytes: { value: number; truncated: boolean }, chunk: string) => {
    if (!captureChunks) return;
    push();
    const ts = new Date().toISOString().slice(11, 23);
    appendBoundedChunk(arr, bytes, `[${ts}] ${chunk}`, maxBytes, maxItems);
  };

  return {
    streamChunks,
    streamChunkBytes,
    appendProviderChunk(chunk: string) {
      append(streamChunks.provider, streamChunkBytes.provider, chunk);
    },
    appendOpenAIChunk(chunk: string) {
      append(streamChunks.openai, streamChunkBytes.openai, chunk);
    },
    appendConvertedChunk(chunk: string) {
      append(streamChunks.client, streamChunkBytes.client, chunk);
    },
  };
}

export async function createRequestLogger(
  _sourceFormat?: string,
  _targetFormat?: string,
  _model?: string,
  options: RequestLoggerOptions = {}
): Promise<RequestLogger> {
  const captureStreamChunks = options.captureStreamChunks !== false;
  // Stream chunk capture is always set up — even when the logger is disabled,
  // so that active requests always have real-time stream data available via
  // the /api/logs/active endpoint.
  const chunkMethods = makeStreamChunkMethods(options, captureStreamChunks);

  if (options.enabled === false) {
    return {
      sessionPath: null,
      logClientRawRequest() {},
      logOpenAIRequest() {},
      logTargetRequest() {},
      logProviderResponse() {},
      appendProviderChunk: chunkMethods.appendProviderChunk,
      appendOpenAIChunk: chunkMethods.appendOpenAIChunk,
      logConvertedResponse() {},
      appendConvertedChunk: chunkMethods.appendConvertedChunk,
      logError() {},
      getPipelinePayloads() {
        return null;
      },
    };
  }

  const payloads: RequestPipelinePayloads = {
    ...(captureStreamChunks ? { streamChunks: chunkMethods.streamChunks } : {}),
  };

  return {
    sessionPath: null,

    logClientRawRequest(endpoint, body, headers = {}) {
      payloads.clientRawRequest = {
        timestamp: new Date().toISOString(),
        endpoint,
        headers: maskSensitiveHeaders(headers),
        body: cloneBoundedForLog(body),
      };
    },

    logOpenAIRequest(body) {
      payloads.openaiRequest = {
        timestamp: new Date().toISOString(),
        body: cloneBoundedForLog(body),
      };
    },

    logTargetRequest(url, headers, body) {
      payloads.providerRequest = {
        timestamp: new Date().toISOString(),
        url,
        headers: maskSensitiveHeaders(headers),
        body: cloneBoundedForLog(body),
      };
    },

    logProviderResponse(status, statusText, headers, body) {
      payloads.providerResponse = {
        timestamp: new Date().toISOString(),
        status,
        statusText,
        headers: maskSensitiveHeaders(headers),
        body: cloneBoundedForLog(body),
      };
    },

    appendProviderChunk: chunkMethods.appendProviderChunk,
    appendOpenAIChunk: chunkMethods.appendOpenAIChunk,
    logConvertedResponse(body) {
      payloads.clientResponse = {
        timestamp: new Date().toISOString(),
        body: cloneBoundedForLog(body),
      };
    },
    appendConvertedChunk: chunkMethods.appendConvertedChunk,

    logError(error, requestBody = null) {
      payloads.error = {
        timestamp: new Date().toISOString(),
        error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
        requestBody: cloneBoundedForLog(requestBody),
      };
    },

    getPipelinePayloads() {
      return compactPipelinePayloads(payloads);
    },
  };
}
