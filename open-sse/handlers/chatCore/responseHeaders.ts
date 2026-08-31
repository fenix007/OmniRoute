import {
  attachOmniRouteMetaHeaders,
  buildOmniRouteResponseMetaHeaders,
} from "@/domain/omnirouteResponseMeta";
import { OMNIROUTE_RESPONSE_HEADERS } from "@/shared/constants/headers";
import { isEmptyContentResponse } from "../../services/errorClassifier.ts";
import { detectMalformedNonStream } from "../../utils/diagnostics.ts";
import { parseNonStreamingSSEPayload } from "./nonStreamingSse.ts";

const STREAMING_RESPONSE_HEADER_DENYLIST = new Set([
  "content-type",
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);

/**
 * Prefix of Next.js internal middleware control headers.
 *
 * When an upstream provider is itself hosted behind a Next.js middleware
 * (e.g. synthetic.new), a perfectly successful `200 OK` response can still
 * carry Next's own control headers such as `x-middleware-rewrite`,
 * `x-middleware-next`, `x-middleware-override-headers`,
 * `x-middleware-set-cookie`, and the `x-middleware-request-*` family.
 *
 * OmniRoute forwards upstream response headers verbatim. If we re-emit those
 * headers from an App Router route handler, Next 16's `app-route` runtime
 * interprets `x-middleware-rewrite` as a `NextResponse.rewrite()` call and
 * throws `NextResponse.rewrite() was used in a app route handler` — turning a
 * successful upstream call into a 500. This is provider-agnostic proxy
 * hygiene: any upstream behind Next middleware can leak these headers.
 *
 * See issue #5849.
 */
const NEXTJS_MIDDLEWARE_HEADER_PREFIX = "x-middleware-";

interface DeduplicatedExecutionSnapshot {
  status: number;
  statusText: string;
  headers: [string, string][];
  payload: string;
}

function getDeduplicatedExecutionSnapshot(
  result: Record<string, unknown> | null | undefined
): DeduplicatedExecutionSnapshot | undefined {
  return result && typeof result === "object"
    ? (result._dedupSnapshot as DeduplicatedExecutionSnapshot | undefined)
    : undefined;
}

function getSnapshotContentType(snapshot: DeduplicatedExecutionSnapshot): string {
  return (
    snapshot.headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] || ""
  ).toLowerCase();
}

function parseSnapshotPayload(snapshot: DeduplicatedExecutionSnapshot): unknown {
  const contentType = getSnapshotContentType(snapshot);
  const looksLikeSSE =
    contentType.includes("text/event-stream") || /(^|\n)\s*(event|data):/m.test(snapshot.payload);

  if (looksLikeSSE) {
    return parseNonStreamingSSEPayload(snapshot.payload, "", "")?.body ?? null;
  }

  try {
    return JSON.parse(snapshot.payload);
  } catch {
    return null;
  }
}

function hasUnusableCompletionPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return true;

  const body = payload as Record<string, unknown>;
  const hasStructuredCompletionShape =
    body.object === "response" ||
    Array.isArray(body.choices) ||
    (body.type === "message" && Array.isArray(body.content));
  if (hasStructuredCompletionShape) {
    return detectMalformedNonStream(body) !== null;
  }

  const hasRecognizedCompletionShape = typeof body.text === "string" || "content" in body;
  if (!hasRecognizedCompletionShape) return true;

  return isEmptyContentResponse(body);
}

/**
 * True when `headerName` is a Next.js internal middleware control header that
 * must never be forwarded from a proxied upstream response.
 */
export function isNextMiddlewareControlHeader(headerName: string): boolean {
  return headerName.toLowerCase().startsWith(NEXTJS_MIDDLEWARE_HEADER_PREFIX);
}

/**
 * Strip the whole `x-middleware-*` family (see {@link isNextMiddlewareControlHeader})
 * from a `Headers` instance. Used on the non-streaming JSON path alongside
 * {@link stripStaleForwardingHeaders}.
 */
export function stripNextMiddlewareControlHeaders(headers: Headers): void {
  const toDelete: string[] = [];
  headers.forEach((_value, key) => {
    if (isNextMiddlewareControlHeader(key)) {
      toDelete.push(key);
    }
  });
  for (const key of toDelete) {
    headers.delete(key);
  }
}

export function buildStreamingResponseHeaders(
  providerHeaders: Headers,
  meta: Parameters<typeof buildOmniRouteResponseMetaHeaders>[0]
): Record<string, string> {
  const forwardedHeaders: [string, string][] = [];
  providerHeaders.forEach((value, key) => {
    if (
      !STREAMING_RESPONSE_HEADER_DENYLIST.has(key.toLowerCase()) &&
      !isNextMiddlewareControlHeader(key)
    ) {
      forwardedHeaders.push([key, value]);
    }
  });

  const responseHeaders: Record<string, string> = {
    ...Object.fromEntries(forwardedHeaders),
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    [OMNIROUTE_RESPONSE_HEADERS.cache]: "MISS",
  };
  attachOmniRouteMetaHeaders(responseHeaders, meta);
  return responseHeaders;
}

export function materializeDeduplicatedExecutionResult<T extends Record<string, unknown>>(
  result: T
): T {
  const snapshot = getDeduplicatedExecutionSnapshot(result);

  if (!snapshot) return result;

  return {
    ...result,
    response: new Response(snapshot.payload, {
      status: snapshot.status,
      statusText: snapshot.statusText,
      headers: snapshot.headers,
    }),
  } as T;
}

/**
 * Only successful, non-empty upstream bodies are safe to fan out to requests that
 * joined an in-flight execution. A waiter must execute independently when the owner
 * received an HTTP error or an empty body, so one bad response cannot poison a burst.
 */
export function isReusableDeduplicatedExecutionResult(
  result: Record<string, unknown> | null | undefined
): boolean {
  const snapshot = getDeduplicatedExecutionSnapshot(result);
  if (!snapshot) return false;
  if (snapshot.status < 200 || snapshot.status >= 300 || snapshot.payload.trim().length === 0) {
    return false;
  }
  return !hasUnusableCompletionPayload(parseSnapshotPayload(snapshot));
}

/**
 * Strip hop-by-hop headers that describe the upstream wire encoding.
 *
 * `readNonStreamingResponseBody` reads (and, for compressed responses, also
 * decompresses via fetch's auto-decoder) the full upstream body into a JS
 * string before we re-emit it to the client. Once that happens, the original
 * `Content-Encoding`, `Content-Length`, and `Transfer-Encoding` all describe
 * a payload that no longer exists:
 *
 *   - `Content-Length` is the *compressed* byte count, so clients honoring it
 *     read only the first N bytes of the decompressed JSON and surface
 *     "Unterminated string in JSON at position …" parse failures (observed
 *     on gzipped Gemini responses).
 *   - `Content-Encoding` advertises a compression we have already undone.
 *   - `Transfer-Encoding` is hop-by-hop per RFC 7230 §6.1 and must not be
 *     forwarded across a buffering proxy — its presence alongside a
 *     re-emitted body is undefined behavior.
 *
 * Deleting all three lets the response framework set a fresh, correct
 * `Content-Length` (or fall back to `Transfer-Encoding: chunked`) for the
 * payload we are actually sending.
 */
export function stripStaleForwardingHeaders(headers: Headers): void {
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
}
