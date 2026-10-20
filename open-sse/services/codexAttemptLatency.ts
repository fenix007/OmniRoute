/**
 * Per-attempt latency of one Codex upstream request.
 *
 * A single TTFT number hides where the time went. A throttled ChatGPT account
 * often accepts a request, sends the lifecycle handshake and then queues it for
 * 10–30 s, so each attempt records four moments, measured from the moment the
 * attempt was dispatched:
 *
 *   - lifecycle: first upstream event of any kind (`response.created`, …);
 *   - firstUseful: first event past the handshake — the backend started work
 *     (reasoning, output items, text, tool arguments);
 *   - firstText: first output text or tool-call argument delta;
 *   - completed: the terminal event, with its outcome.
 *
 * Only the first occurrence of each moment counts, so feeding the same bytes
 * twice (the transient-error peek, then the replayed stream) is harmless.
 * firstUseful feeds the short-term account health exactly once per attempt, and
 * the request sees a snapshot at firstUseful and again when the attempt ends.
 */

import { recordCodexTtft } from "./codexConnectionHealth.ts";

export type CodexAttemptTransport = "http" | "ws";
export type CodexAttemptOutcome = "completed" | "failed" | "incomplete" | "aborted" | "unknown";

export interface CodexAttemptLatency {
  connectionId: string | null;
  transport: CodexAttemptTransport;
  startedAt: number;
  lifecycleMs: number | null;
  firstUsefulMs: number | null;
  firstUsefulType: string | null;
  firstTextMs: number | null;
  completedMs: number | null;
  outcome: CodexAttemptOutcome | null;
}

export type CodexAttemptLatencySink = (sample: CodexAttemptLatency) => void;

type CodexEventClass = "lifecycle" | "useful" | "text" | "completed" | "failed" | "incomplete";

const LIFECYCLE_EVENT_TYPES = new Set([
  "response.created",
  "response.in_progress",
  "response.queued",
  "codex.rate_limits",
]);

const TEXT_EVENT_TYPES = new Set([
  "response.output_text.delta",
  "response.refusal.delta",
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
]);

/** How many leading characters of a `data:` line are kept to find its `type`. */
const DATA_LINE_PREFIX_CHARS = 512;

export function classifyCodexEventType(type: string): CodexEventClass | null {
  if (!type) return null;
  if (LIFECYCLE_EVENT_TYPES.has(type)) return "lifecycle";
  if (type === "response.completed") return "completed";
  if (type === "response.failed" || type === "error") return "failed";
  if (type === "response.incomplete") return "incomplete";
  if (TEXT_EVENT_TYPES.has(type)) return "text";
  if (type.startsWith("response.")) return "useful";
  return null;
}

/** The `type` of one JSON event payload, read from its first characters only. */
export function readCodexEventType(payloadPrefix: string): string | null {
  const match = /"type"\s*:\s*"([^"]{1,128})"/.exec(payloadPrefix);
  return match ? match[1] : null;
}

export class CodexAttemptObserver {
  readonly connectionId: string | null;
  readonly transport: CodexAttemptTransport;
  readonly startedAt: number;
  private readonly now: () => number;
  private readonly sink: CodexAttemptLatencySink | null;
  private lifecycleAt: number | null = null;
  private firstUsefulAt: number | null = null;
  private firstUsefulType: string | null = null;
  private firstTextAt: number | null = null;
  private completedAt: number | null = null;
  private outcome: CodexAttemptOutcome | null = null;
  private finished = false;

  constructor(options: {
    connectionId?: string | null;
    transport: CodexAttemptTransport;
    sink?: CodexAttemptLatencySink | null;
    now?: () => number;
  }) {
    this.connectionId = options.connectionId || null;
    this.transport = options.transport;
    this.sink = options.sink ?? null;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  observeEventType(type: string | null): void {
    if (!type || this.finished) return;
    const eventClass = classifyCodexEventType(type);
    if (!eventClass) return;

    const at = this.now();
    if (this.lifecycleAt === null) this.lifecycleAt = at;

    if (eventClass === "useful" || eventClass === "text") {
      if (this.firstUsefulAt === null) {
        this.firstUsefulAt = at;
        this.firstUsefulType = type;
        if (this.connectionId) recordCodexTtft(this.connectionId, at - this.startedAt, at);
        this.publish();
      }
      if (eventClass === "text" && this.firstTextAt === null) this.firstTextAt = at;
      return;
    }

    if (eventClass === "completed" || eventClass === "failed" || eventClass === "incomplete") {
      this.completedAt = at;
      this.outcome = eventClass;
      this.finish(eventClass);
    }
  }

  /** Ends the attempt once; later calls and events are ignored. */
  finish(outcome: CodexAttemptOutcome = "unknown"): void {
    if (this.finished) return;
    this.finished = true;
    if (this.outcome === null) this.outcome = outcome;
    this.publish();
  }

  /** Hands the current snapshot to the request; the latest call wins. */
  private publish(): void {
    if (!this.sink) return;
    try {
      this.sink(this.snapshot());
    } catch {
      // Telemetry must never break the stream.
    }
  }

  snapshot(): CodexAttemptLatency {
    const since = (at: number | null) => (at === null ? null : at - this.startedAt);
    return {
      connectionId: this.connectionId,
      transport: this.transport,
      startedAt: this.startedAt,
      lifecycleMs: since(this.lifecycleAt),
      firstUsefulMs: since(this.firstUsefulAt),
      firstUsefulType: this.firstUsefulType,
      firstTextMs: since(this.firstTextAt),
      completedMs: since(this.completedAt),
      outcome: this.outcome,
    };
  }
}

/**
 * Incremental SSE scanner: feeds the observer the `type` of every `data:` line.
 * A line split across chunks is reassembled, but only its first
 * DATA_LINE_PREFIX_CHARS characters are kept, so a huge payload costs no memory.
 */
export class CodexSseEventScanner {
  private partial = "";
  private partialTruncated = false;
  private readonly decoder = new TextDecoder();

  constructor(private readonly observer: CodexAttemptObserver) {}

  push(chunk: Uint8Array | string): void {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) {
        this.appendPartial(text.slice(start));
        return;
      }
      this.appendPartial(text.slice(start, newline));
      this.consumeLine(this.partial);
      this.partial = "";
      this.partialTruncated = false;
      start = newline + 1;
    }
  }

  private appendPartial(piece: string): void {
    if (this.partialTruncated) return;
    const room = DATA_LINE_PREFIX_CHARS - this.partial.length;
    if (piece.length > room) {
      this.partial += piece.slice(0, room);
      this.partialTruncated = true;
    } else {
      this.partial += piece;
    }
  }

  private consumeLine(line: string): void {
    if (!line.startsWith("data:")) return;
    this.observer.observeEventType(readCodexEventType(line));
  }
}

/**
 * Pass a Codex SSE response through unchanged while feeding the observer.
 * The attempt ends when the upstream body ends, errors or is cancelled.
 */
export function observeCodexSseResponse(
  response: Response,
  observer: CodexAttemptObserver
): Response {
  if (!response.body) {
    observer.finish("unknown");
    return response;
  }
  const scanner = new CodexSseEventScanner(observer);
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          observer.finish("unknown");
          controller.close();
          return;
        }
        if (value) {
          scanner.push(value);
          controller.enqueue(value);
        }
      } catch (error) {
        observer.finish("failed");
        controller.error(error);
      }
    },
    async cancel(reason) {
      observer.finish("aborted");
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
