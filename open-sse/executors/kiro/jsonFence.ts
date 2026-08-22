/**
 * Strip a markdown code fence from Kiro content when the request asked for JSON.
 *
 * Kiro/CodeWhisperer has no `response_format`, so the JSON contract can only be
 * stated in the prompt (see `translator/request/openai-to-kiro/responseFormat.ts`).
 * Claude on Kiro honours the schema but wraps the object in a ```json fence
 * anyway — both `claude-haiku-4.5` and `claude-sonnet-4.5` did so on every
 * production probe, despite the prompt forbidding it. An OpenAI-conforming
 * client that `JSON.parse`s `message.content` breaks on that fence, so remove it
 * here, on the one route where `response_format` cannot be enforced upstream.
 *
 * Applied only when the request carries `response_format: json_schema |
 * json_object`; a normal chat answer keeps its code blocks untouched.
 */

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

/** Opening fence, with optional language tag, at the very start of the reply. */
const OPENING_FENCE = /^\s*```[A-Za-z0-9_-]*[ \t]*\r?\n/;
/** Trailing run that could still grow into a closing fence — held back. */
const CLOSING_FENCE_HOLD = /[\s`]*$/;
/** Closing fence at the very end of the reply. */
const CLOSING_FENCE = /\s*```\s*$/;
/** Give up looking for an opening fence once this much content has arrived. */
const PREFIX_DECISION_CHARS = 16;

export type JsonFenceState = { pending: string; prefixResolved: boolean };

export function createJsonFenceState(): JsonFenceState {
  return { pending: "", prefixResolved: false };
}

/** True when the request asked for a JSON-only reply. */
export function wantsJsonOnlyContent(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const format = (body as { response_format?: unknown }).response_format;
  if (!format || typeof format !== "object" || Array.isArray(format)) return false;
  const type = (format as { type?: unknown }).type;
  return type === "json_schema" || type === "json_object";
}

/**
 * Feed one content delta through the stripper and return what may be emitted
 * now. A trailing run of whitespace/backticks is held back until `flush` can
 * tell a closing fence from real content.
 */
export function pushJsonFenceChunk(state: JsonFenceState, text: string): string {
  state.pending += text;

  if (!state.prefixResolved) {
    const opening = OPENING_FENCE.exec(state.pending);
    if (opening) {
      state.pending = state.pending.slice(opening[0].length);
      state.prefixResolved = true;
    } else if (
      /\r?\n/.test(state.pending) ||
      state.pending.trimStart().length > PREFIX_DECISION_CHARS
    ) {
      state.prefixResolved = true;
    } else {
      return "";
    }
  }

  const hold = CLOSING_FENCE_HOLD.exec(state.pending)?.[0] ?? "";
  const emit = state.pending.slice(0, state.pending.length - hold.length);
  state.pending = hold;
  return emit;
}

/** Emit whatever is still held back, minus a closing fence. */
export function flushJsonFence(state: JsonFenceState): string {
  const out = state.pending.replace(CLOSING_FENCE, "");
  state.pending = "";
  state.prefixResolved = true;
  return out;
}

type ChunkMeta = { id?: unknown; created?: unknown; model?: unknown };

function contentChunkLine(meta: ChunkMeta, content: string): string {
  return `data: ${JSON.stringify({
    ...meta,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}`;
}

/**
 * Rewrite the `delta.content` of every chunk on an OpenAI SSE stream through the
 * fence stripper. Held-back content is released as its own chunk immediately
 * before the finishing chunk (or `[DONE]`), so ordering stays intact.
 */
export function stripJsonFenceFromSse(
  body: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const state = createJsonFenceState();
  let lineBuffer = "";
  let meta: ChunkMeta = {};

  const processLine = (line: string): string[] => {
    if (!line.startsWith("data: ")) return [line];
    const payload = line.slice("data: ".length);

    if (payload === "[DONE]") {
      const tail = flushJsonFence(state);
      return tail ? [contentChunkLine(meta, tail), line] : [line];
    }

    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return [line];
    }

    meta = { id: chunk.id, created: chunk.created, model: chunk.model };
    const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) return [line];

    if (choice.finish_reason != null) {
      const tail = flushJsonFence(state);
      return tail ? [contentChunkLine(meta, tail), line] : [line];
    }

    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta || typeof delta.content !== "string") return [line];

    delta.content = pushJsonFenceChunk(state, delta.content);
    return [`data: ${JSON.stringify(chunk)}`];
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        lineBuffer += TEXT_DECODER.decode(bytes, { stream: true });
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          for (const out of processLine(line)) {
            controller.enqueue(TEXT_ENCODER.encode(`${out}\n`));
          }
        }
      },
      flush(controller) {
        if (lineBuffer) {
          for (const out of processLine(lineBuffer)) {
            controller.enqueue(TEXT_ENCODER.encode(out));
          }
        }
        const tail = flushJsonFence(state);
        if (tail) {
          controller.enqueue(TEXT_ENCODER.encode(`${contentChunkLine(meta, tail)}\n\n`));
        }
      },
    })
  );
}
