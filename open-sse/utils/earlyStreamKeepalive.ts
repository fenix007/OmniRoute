/**
 * Early SSE keepalive wrapper for streaming route handlers.
 *
 * Strict HTTP clients (notably Codex CLI's `reqwest`, which has a ~5s idle-read
 * timeout) drop the connection if no bytes arrive shortly after the request.
 * OmniRoute, however, holds the streaming response until `ensureStreamReadiness`
 * observes the upstream's first useful byte — which can exceed 5s for reasoning
 * models that "think" before emitting any token (#2544). `curl` has no such
 * idle timeout, so it was never affected, which is why the bug looked
 * client-specific.
 *
 * This wrapper keeps the connection warm without disturbing the handler's
 * internal logic (combo failover, stream readiness, account cooldown all still
 * run inside the handler before it resolves):
 *
 *   - Fast path: if the handler resolves within `thresholdMs`, its `Response`
 *     is returned verbatim — identical status, headers, and body. There is zero
 *     behavior change for normal latency, so metadata headers and non-200 error
 *     statuses are fully preserved for the common case.
 *
 *   - Slow path: if the handler is still pending after `thresholdMs`, a 200
 *     `text/event-stream` response is opened immediately and SSE comment
 *     heartbeats are emitted every `intervalMs` until the handler resolves; its
 *     body is then forwarded. If the handler ultimately fails, a structured
 *     `event: error` frame is emitted in-band (the response is already committed
 *     to 200, so the HTTP status can no longer change) — carrying `error.status`
 *     so a client can still tell a retryable 5xx/429 from a terminal 4xx.
 */

const ENCODER = new TextEncoder();
const KEEPALIVE_FRAME = ENCODER.encode(": omniroute-keepalive\n\n");
// Anthropic Messages-format keepalive: a REAL `ping` SSE event, not a comment.
// Anthropic clients (Claude Code, the Anthropic SDK) reset their stream/first-token
// watchdog on real SSE events but ignore SSE comments (`: ...`), so on a slow first
// token the comment frame lets the client abort and retry the stream. Anthropic's own
// API emits `event: ping` for exactly this reason; the /v1/messages route mirrors it.
export const ANTHROPIC_PING_FRAME = ENCODER.encode('event: ping\ndata: {"type":"ping"}\n\n');
const ERROR_FRAME = ENCODER.encode(
  `event: error\ndata: ${JSON.stringify({
    error: { message: "Upstream stream failed before completion.", type: "stream_error" },
  })}\n\n`
);

export type EarlyStreamKeepaliveOptions = {
  /** Wait this long for the handler before committing to a keepalive stream. */
  thresholdMs?: number;
  /** Keepalive cadence once committed (must stay under the client idle timeout). */
  intervalMs?: number;
  /** Client request signal — propagated so a client disconnect cancels the upstream read. */
  signal?: AbortSignal | null;
  /**
   * Frame emitted on each keepalive tick. Defaults to an SSE comment
   * (`: omniroute-keepalive`). Anthropic-format routes (/v1/messages) must pass
   * `ANTHROPIC_PING_FRAME` instead, because Anthropic clients ignore SSE comments
   * for their stream watchdog and only a real `event: ping` keeps them from aborting.
   */
  keepaliveFrame?: Uint8Array;
  /** Extra headers to include in the keepalive response (e.g. X-Correlation-Id). */
  extraHeaders?: Record<string, string>;
  /**
   * Shape AND event name of the in-band error frame. Each client family parses only
   * its own: Anthropic clients (/v1/messages) branch on `error.type` and ignore an
   * OpenAI-shaped `{"error":{...}}` frame, while Responses API clients (/v1/responses,
   * notably Codex CLI) act only on a `response.failed` event and ignore `event: error`
   * whatever its payload. Sending the wrong one makes a failure look to the client like
   * a stream that simply stopped.
   */
  errorFrameFormat?: ErrorFrameFormat;
};

type SettledHandler = { ok: true; response: Response } | { ok: false; error: unknown };

export type ErrorFrameFormat = "openai" | "anthropic" | "responses";

/** Generic in-band failure text used when no upstream message exists. */
const GENERIC_FAILURE_MESSAGE = "Upstream stream failed before completion.";

/**
 * SSE event name each client family listens on for an in-band failure. Responses API
 * clients terminate a stream on `response.failed` and ignore `event: error` entirely,
 * so the event name is part of the format, not just the payload.
 */
const ERROR_FRAME_EVENT_NAMES: Record<ErrorFrameFormat, string> = {
  openai: "error",
  anthropic: "error",
  responses: "response.failed",
};

export function errorFrameEventName(format: ErrorFrameFormat = "openai"): string {
  return ERROR_FRAME_EVENT_NAMES[format] ?? "error";
}

/**
 * Maps an HTTP status onto an Anthropic error type. Anthropic clients (Claude Code,
 * the Anthropic SDK) branch on `error.type` inside the stream, not on the status line
 * they can no longer see — `overloaded_error` and `rate_limit_error` are the two types
 * they treat as retryable, so an upstream capacity failure must arrive as one of them
 * or the client gives up on a transient error.
 *
 * Mirrors the status→claude mapping in ./streamHandler.ts (getStreamErrorStatusMapping);
 * duplicated deliberately rather than imported, because that module pulls in the usage
 * DB and this helper runs on every streaming route.
 */
function anthropicErrorType(status: number, message: string): string {
  if (status === 429) return "rate_limit_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status >= 400 && status < 500) return "invalid_request_error";
  // Provider capacity failures reach us as 502/503 (and 529 upstream); the message is
  // the only discriminator when a gateway flattens them all onto 502.
  if (status === 502 || status === 503 || status === 529) return "overloaded_error";
  if (looksLikeCapacityFailure(message)) return "overloaded_error";
  return "api_error";
}

/** True when the message reads as a transient provider capacity failure. */
function looksLikeCapacityFailure(message: string): boolean {
  return /overload|at capacity|capacity constraint|try again later/i.test(message);
}

/**
 * Maps an HTTP status onto a Responses API error code. Codex CLI reads the failure off
 * the `response.failed` event's `error.code` / `error.status_code`, so a transient
 * capacity failure must arrive with a code it recognizes as retryable rather than the
 * generic `server_error` it treats as terminal.
 */
function responsesErrorCode(status: number, message: string): string {
  if (status === 429) return "rate_limit_exceeded";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found";
  if (status === 413) return "request_too_large";
  if (status >= 400 && status < 500) return "invalid_request_error";
  // Provider capacity failures reach us as 502/503 (529 upstream); when a gateway
  // flattens them all onto 502 the message is the only discriminator left.
  if (status === 502 || status === 503 || status === 529) return "server_overloaded";
  if (looksLikeCapacityFailure(message)) return "server_overloaded";
  return "server_error";
}

/** Best-effort extraction of a human-readable message from either error shape. */
function readErrorMessage(bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed.startsWith("{")) return trimmed;

  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: unknown }; message?: unknown };
    const nested = parsed?.error?.message;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
    if (typeof parsed?.message === "string" && parsed.message.trim()) return parsed.message.trim();
  } catch {
    /* fall through — unparseable body */
  }

  return trimmed;
}

/**
 * Builds the `data:` payload for an in-band error frame in the format the route's
 * clients actually parse. An OpenAI-shaped `{"error":{...}}` frame is silently ignored
 * by both other families — an Anthropic client branches on `error.type`, and a Responses
 * API client acts only on a `response.failed` envelope — so the wrong shape makes a
 * /v1/messages or /v1/responses caller see the stream simply end instead of learning it
 * failed. Pair this with {@link errorFrameEventName} for the matching event name.
 */
export function buildErrorFrameData(
  bodyText: string,
  status: number,
  format: ErrorFrameFormat = "openai"
): string {
  if (format === "openai") return annotateErrorFrameStatus(bodyText, status);

  const message = readErrorMessage(bodyText) || GENERIC_FAILURE_MESSAGE;

  if (format === "anthropic") {
    return JSON.stringify({
      type: "error",
      error: { type: anthropicErrorType(status, message), message, status },
    });
  }

  // Responses API envelope, mirroring the shape the codex executor already emits for
  // upstream failures (open-sse/executors/codex.ts) so clients see one consistent
  // failure event: the status travels in `status_code`, as it does there.
  return JSON.stringify({
    type: "response.failed",
    response: {
      id: null,
      status: "failed",
      error: {
        type: status >= 400 && status < 500 ? "invalid_request_error" : "server_error",
        code: responsesErrorCode(status, message),
        message,
        status_code: status,
      },
    },
  });
}

/**
 * Annotates an in-band error payload with the HTTP status the handler wanted to
 * return. Once the keepalive stream commits to 200 the status line is gone, so the
 * only place a client can still learn "this was a 502, retry it" is the error frame
 * itself. Without this, a transient upstream failure is indistinguishable from a
 * terminal one and client retry logic keyed on the status never runs.
 *
 * The body is already sanitized by the handler; this only adds `error.status` (and
 * never overwrites one the handler set). Non-JSON or unexpected shapes are passed
 * through untouched — an unparseable body must still reach the client verbatim.
 */
export function annotateErrorFrameStatus(bodyText: string, status: number): string {
  if (!Number.isInteger(status) || status < 400 || status > 599) return bodyText;

  const trimmed = bodyText.trim();
  if (!trimmed.startsWith("{")) return bodyText;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bodyText;

    const error = (parsed as { error?: unknown }).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return bodyText;

    if ((error as { status?: unknown }).status !== undefined) return bodyText;

    (error as { status?: number }).status = status;
    return JSON.stringify(parsed);
  } catch {
    return bodyText;
  }
}

export async function withEarlyStreamKeepalive(
  handlerPromise: Promise<Response>,
  options: EarlyStreamKeepaliveOptions = {}
): Promise<Response> {
  const thresholdMs = Math.max(0, options.thresholdMs ?? 2_000);
  const intervalMs = Math.max(250, options.intervalMs ?? 2_500);
  const signal = options.signal ?? null;
  const keepaliveFrame = options.keepaliveFrame ?? KEEPALIVE_FRAME;
  const extraHeaders = options.extraHeaders ?? {};
  const errorFrameFormat = options.errorFrameFormat ?? "openai";
  const errorEventName = errorFrameEventName(errorFrameFormat);
  // Handler-rejection frame: no upstream status exists, so report a generic 502
  // (never the raw error/stack) in the format this route's clients parse.
  const genericErrorFrame =
    errorFrameFormat === "openai"
      ? ERROR_FRAME
      : ENCODER.encode(
          `event: ${errorEventName}\ndata: ${buildErrorFrameData(
            GENERIC_FAILURE_MESSAGE,
            502,
            errorFrameFormat
          )}\n\n`
        );

  // Settle into a tagged result so neither race branch leaves an unhandled
  // rejection when the threshold timer wins.
  const settled: Promise<SettledHandler> = handlerPromise.then(
    (response) => ({ ok: true as const, response }),
    (error) => ({ ok: false as const, error })
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const raced = await Promise.race([
    settled.then((result) => ({ kind: "settled" as const, result })),
    new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), thresholdMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (raced.kind === "settled") {
    // Fast path — return verbatim, or rethrow so the route's normal error handling runs.
    if (raced.result.ok) return raced.result.response;
    throw raced.result.error;
  }

  // Slow path — open the SSE stream now and keep it warm until the handler resolves.
  // Cleanup state is hoisted so both start() and cancel() (client disconnect) can stop
  // the keepalive loop and cancel the upstream read.
  let stopKeepalive = () => {};
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let aborted = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let stopped = false;
      const interval = setInterval(() => {
        if (stopped) return;
        try {
          controller.enqueue(keepaliveFrame);
        } catch {
          stopped = true;
          clearInterval(interval);
        }
      }, intervalMs);
      if (interval && typeof interval === "object" && "unref" in interval) {
        interval.unref?.();
      }
      // First keepalive immediately on commit so the client sees a byte right away.
      // Use the configured frame (e.g. ANTHROPIC_PING_FRAME) — an SSE comment here
      // would be ignored by Anthropic clients' watchdog on a sub-interval gap,
      // defeating the keepalive for exactly the case it targets.
      try {
        controller.enqueue(keepaliveFrame);
      } catch {
        /* consumer already gone */
      }

      stopKeepalive = () => {
        stopped = true;
        clearInterval(interval);
      };

      const onAbort = () => {
        aborted = true;
        stopKeepalive();
        upstreamReader?.cancel().catch(() => {});
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const result = await settled;
        stopKeepalive();
        if (aborted) return; // client disconnected while we were waiting

        if (!result.ok) {
          // Handler rejected — emit a generic error frame (never the raw error/stack).
          controller.enqueue(genericErrorFrame);
        } else {
          const response = result.response;
          const contentType = (response.headers.get("content-type") || "").toLowerCase();
          const isSse = contentType.includes("text/event-stream");

          if (response.body && isSse) {
            // Real SSE stream — forward it verbatim.
            upstreamReader = response.body.getReader();
            let bytesForwarded = 0;
            try {
              while (true) {
                const { done, value } = await upstreamReader.read();
                if (done) break;
                if (value) {
                  controller.enqueue(value);
                  bytesForwarded += value.byteLength;
                }
              }
            } catch (readErr) {
              // Upstream stream failed mid-flight. Only emit an error frame if
              // NO content was forwarded yet — otherwise the client already
              // received partial content and a late error frame would corrupt
              // the SSE stream. Silently close instead; the client will see
              // the stream end naturally.
              if (bytesForwarded === 0) {
                controller.enqueue(genericErrorFrame);
              }
            }
          } else {
            // Non-SSE response (e.g. a JSON error) reached us after we already
            // committed to a 200 event-stream, so the HTTP status can no longer
            // change. Frame the (already-sanitized) body as an in-band error event
            // instead of forwarding raw JSON, which would be malformed SSE.
            const text = response.body ? await response.text().catch(() => "") : "";
            const dataLine = buildErrorFrameData(
              text.trim() || "stream_error",
              response.status,
              errorFrameFormat
            );
            controller.enqueue(ENCODER.encode(`event: ${errorEventName}\ndata: ${dataLine}\n\n`));
          }
        }
      } catch {
        // Defensive: never surface a raw error/stack to the client.
        if (!aborted) {
          try {
            controller.enqueue(genericErrorFrame);
          } catch {
            /* consumer gone */
          }
        }
      } finally {
        stopKeepalive();
        signal?.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      // Consumer (Next.js → client) went away — stop keepalives and release the upstream.
      aborted = true;
      stopKeepalive();
      upstreamReader?.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...extraHeaders,
    },
  });
}
