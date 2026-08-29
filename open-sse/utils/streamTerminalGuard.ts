import { createStreamContentWatcher } from "./streamReadiness.ts";

export type StreamTerminalGateResult = {
  chunks: Uint8Array[];
  emptyTerminal: boolean;
};

/**
 * Bounded client-facing SSE frame gate. Complete non-terminal frames pass
 * immediately; a success terminal is held just long enough to prove that the
 * stream produced content, a tool/reasoning result, or a legitimate empty end.
 */
export function createStreamTerminalGate(isTerminalFrame: (frame: string) => boolean): {
  note: (chunk: Uint8Array) => StreamTerminalGateResult;
  finish: () => StreamTerminalGateResult;
} {
  const MAX_PENDING_SSE_FRAME_CHARS = 1024 * 1024;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const watcher = createStreamContentWatcher();
  let pending = "";
  let disabled = false;
  let stopped = false;
  let validated = false;

  const shouldReplaceTerminal = (): boolean =>
    watcher.sawSseFrame() &&
    !watcher.sawContent() &&
    !watcher.sawLegitEmptyTerminal() &&
    !watcher.sawError();

  const processFrame = (frame: string, chunks: Uint8Array[]): boolean => {
    watcher.note(frame);
    if (isTerminalFrame(frame) && shouldReplaceTerminal()) {
      pending = "";
      stopped = true;
      return false;
    }
    validated = watcher.sawContent() || watcher.sawLegitEmptyTerminal() || watcher.sawError();
    chunks.push(encoder.encode(frame));
    return true;
  };

  const drainCompleteFrames = (chunks: Uint8Array[]): boolean => {
    for (;;) {
      const boundary = pending.search(/\r?\n\r?\n/);
      if (boundary === -1) return true;
      const separator = pending.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
      const frameEnd = boundary + separator.length;
      const frame = pending.slice(0, frameEnd);
      pending = pending.slice(frameEnd);
      if (!processFrame(frame, chunks)) return false;
    }
  };

  const forwardText = (text: string, chunks: Uint8Array[]): void => {
    if (text) chunks.push(encoder.encode(text));
  };

  const process = (text: string, flush: boolean): StreamTerminalGateResult => {
    const chunks: Uint8Array[] = [];
    if (stopped) return { chunks, emptyTerminal: true };

    if (disabled || validated) {
      forwardText(text, chunks);
      return { chunks, emptyTerminal: false };
    }

    pending += text;
    if (!drainCompleteFrames(chunks)) return { chunks, emptyTerminal: true };
    if (validated) {
      forwardText(pending, chunks);
      pending = "";
      return { chunks, emptyTerminal: false };
    }

    if (flush && pending) {
      const frame = pending;
      pending = "";
      if (!processFrame(frame, chunks)) return { chunks, emptyTerminal: true };
    } else if (pending.length > MAX_PENDING_SSE_FRAME_CHARS) {
      // Fail open above the cap: compatibility with unusually large provider
      // frames is safer than buffering attacker-controlled input indefinitely.
      disabled = true;
      watcher.note(pending);
      chunks.push(encoder.encode(pending));
      pending = "";
    }

    if (flush) {
      watcher.finish();
      if (shouldReplaceTerminal()) {
        stopped = true;
        return { chunks, emptyTerminal: true };
      }
    }
    return { chunks, emptyTerminal: false };
  };

  return {
    note: (chunk) => process(decoder.decode(chunk, { stream: true }), false),
    finish: () => process(decoder.decode(), true),
  };
}
