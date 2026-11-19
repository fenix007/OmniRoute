import { parseSSEDataLines } from "../../utils/streamHelpers.ts";

const CAPACITY_CODES = new Set(["server_is_overloaded", "service_unavailable_error"]);
const CAPACITY_MESSAGES = ["selected model is at capacity", "currently overloaded"];
const HANDSHAKE_EVENTS = new Set(["response.created", "response.in_progress", "codex.rate_limits"]);
const FAILURE_EVENTS = new Set(["error", "response.failed"]);
const SSE_PREFIXES = ["event:", "data:", "id:", "retry:", ":"];

type PeekDecision = { matched: string; message: string } | "passthrough" | null;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function classifyFailure(payload: Record<string, unknown>): PeekDecision {
  const error = asRecord(payload.response)?.error ?? payload.error;
  const record = asRecord(error) ?? payload;
  const message = textValue(record.message) || textValue(error);
  const lowerMessage = message.toLowerCase();
  const matched =
    [record.code, record.type]
      .map((value) => textValue(value).toLowerCase())
      .find((code) => CAPACITY_CODES.has(code)) ??
    CAPACITY_MESSAGES.find((phrase) => lowerMessage.includes(phrase));
  return matched ? { matched, message: message || matched } : "passthrough";
}

function inspectFrame(frame: string): PeekDecision {
  const lines = frame.split(/\r?\n/);
  const event =
    lines
      .findLast((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim() ?? "";
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5));
  const payload = asRecord(parseSSEDataLines(data, { logWarning: false }));
  if (!payload) return null;
  const type = textValue(payload.type) || event;
  if (HANDSHAKE_EVENTS.has(type)) return null;
  if (FAILURE_EVENTS.has(type) || (!type && payload.error != null)) return classifyFailure(payload);
  return "passthrough";
}

export class CodexSsePeek {
  private pending = "";
  private needsSniff: boolean;

  constructor(headerless: boolean) {
    this.needsSniff = headerless;
  }

  push(text: string): PeekDecision {
    this.pending += text;
    if (this.needsSniff) {
      const prefix = this.pending.trimStart();
      if (SSE_PREFIXES.some((field) => prefix.startsWith(field))) {
        this.needsSniff = false;
      } else {
        return SSE_PREFIXES.some((field) => field.startsWith(prefix)) ? null : "passthrough";
      }
    }

    const boundaries = /\r?\n\r?\n/g;
    let start = 0;
    for (const boundary of this.pending.matchAll(boundaries)) {
      const decision = inspectFrame(this.pending.slice(start, boundary.index));
      if (decision) return decision;
      start = boundary.index + boundary[0].length;
    }
    this.pending = this.pending.slice(start);
    return null;
  }
}
