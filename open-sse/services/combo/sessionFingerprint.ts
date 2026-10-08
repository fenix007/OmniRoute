import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function normalizeSessionKey(value: unknown, prefix: string): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const trimmed = value.trim();
  if (trimmed.length <= 180 && /^[A-Za-z0-9._:-]+$/.test(trimmed)) {
    return `${prefix}:${trimmed}`;
  }
  return `${prefix}:sha256:${createHash("sha256").update(trimmed).digest("hex")}`;
}

function extractText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === "string") return item;
        const record = asRecord(item);
        if (typeof record.text === "string") return record.text;
        if (typeof record.content === "string") return record.content;
        return null;
      })
      .filter(Boolean) as string[];
    return parts.length > 0 ? parts.join("\n") : JSON.stringify(value);
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return null;
}

function getFirstInputText(body: unknown): string | null {
  const record = asRecord(body);
  if (record.input !== undefined) {
    if (typeof record.input === "string") return record.input;
    if (Array.isArray(record.input)) {
      for (const item of record.input) {
        const itemRecord = asRecord(item);
        const text = extractText(itemRecord.content ?? item);
        if (text && text.trim().length > 0) return text;
      }
    }
    const text = extractText(record.input);
    if (text && text.trim().length > 0) return text;
  }

  if (Array.isArray(record.messages)) {
    const userMessage = record.messages.find((message) => asRecord(message).role === "user");
    const firstMessage = userMessage ?? record.messages[0];
    const text = extractText(asRecord(firstMessage).content ?? firstMessage);
    if (text && text.trim().length > 0) return text;
  }

  return null;
}

/** Preserve the pre-scoped body fingerprint used only by combo context-cache pinning. */
export function deriveComboConversationFingerprint(body: unknown): string | null {
  const record = asRecord(body);
  const metadata = asRecord(record.metadata);
  const explicitKey =
    normalizeSessionKey(metadata.session_id, "metadata") ??
    normalizeSessionKey(metadata.sessionId, "metadata") ??
    normalizeSessionKey(record.conversation_id, "conversation") ??
    normalizeSessionKey(record.session_id, "session") ??
    normalizeSessionKey(record.prompt_cache_key, "prompt-cache");
  if (explicitKey) return explicitKey;

  const inputText = getFirstInputText(body);
  if (!inputText || inputText.trim().length === 0) return null;
  return `input:sha256:${createHash("sha256").update(inputText.slice(0, 4096)).digest("hex")}`;
}
