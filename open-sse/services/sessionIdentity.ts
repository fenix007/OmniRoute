import { createHash } from "node:crypto";

import { z } from "zod";

export type SessionIdentitySource =
  "header" | "metadata" | "conversation" | "session" | "prompt-cache" | "input" | "none";

export type SessionIdentityConfidence = "explicit" | "derived" | "none";

export type ResolvedSessionIdentity = {
  key: string | null;
  source: SessionIdentitySource;
  confidence: SessionIdentityConfidence;
  upstreamSessionId: string | null;
};

type HeaderSource =
  Headers | Record<string, unknown> | { get?: (name: string) => string | null } | null | undefined;

type IdentityCandidate = {
  identifier: string;
  source: Exclude<SessionIdentitySource, "input" | "none">;
};

const SESSION_IDENTITY_VERSION = "v1";
const MAX_EXPLICIT_ID_LENGTH = 512;
const MAX_AUTH_SCOPE_LENGTH = 256;
const MAX_INPUT_PREFIX_LENGTH = 4096;

const explicitIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_EXPLICIT_ID_LENGTH)
  .regex(/^[^\u0000-\u001F\u007F]+$/);
const authenticatedScopeSchema = z.string().trim().min(1).max(MAX_AUTH_SCOPE_LENGTH);

const HEADER_ID_NAMES = [
  "x-codex-session-id",
  "x-session-id",
  "x_session_id",
  "x-omniroute-session-id",
  "x-omniroute-session",
  "session_id",
  "session-id",
  "conversation",
  "conversation_id",
  "conversation-id",
  "thread",
  "thread_id",
  "thread-id",
] as const;

const METADATA_ID_NAMES = [
  "session_id",
  "session-id",
  "sessionId",
  "session",
  "conversation_id",
  "conversation-id",
  "conversationId",
  "conversation",
  "thread_id",
  "thread-id",
  "threadId",
  "thread",
] as const;

const CONVERSATION_ID_NAMES = [
  "conversation_id",
  "conversation-id",
  "conversationId",
  "conversation",
  "thread_id",
  "thread-id",
  "threadId",
  "thread",
] as const;

const SESSION_ID_NAMES = ["session_id", "session-id", "sessionId", "session"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseBoundedString(value: unknown): string | null {
  const result = explicitIdentifierSchema.safeParse(value);
  return result.success ? result.data : null;
}

function readHeader(headers: HeaderSource, name: string): string | null {
  if (!headers) return null;

  if (headers instanceof Headers) {
    return parseBoundedString(headers.get(name));
  }

  if ("get" in headers && typeof headers.get === "function") {
    return parseBoundedString(headers.get(name));
  }

  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return parseBoundedString(entry?.[1]);
}

function firstRecordValue(
  record: Record<string, unknown> | null,
  names: readonly string[]
): string | null {
  if (!record) return null;
  for (const name of names) {
    const value = parseBoundedString(record[name]);
    if (value) return value;
  }
  return null;
}

function findExplicitCandidate(body: unknown, headers: HeaderSource): IdentityCandidate | null {
  for (const name of HEADER_ID_NAMES) {
    const identifier = readHeader(headers, name);
    if (identifier) return { identifier, source: "header" };
  }

  const bodyRecord = asRecord(body);
  const metadataIdentifier = firstRecordValue(asRecord(bodyRecord?.metadata), METADATA_ID_NAMES);
  if (metadataIdentifier) return { identifier: metadataIdentifier, source: "metadata" };

  const conversationIdentifier = firstRecordValue(bodyRecord, CONVERSATION_ID_NAMES);
  if (conversationIdentifier) {
    return { identifier: conversationIdentifier, source: "conversation" };
  }

  const sessionIdentifier = firstRecordValue(bodyRecord, SESSION_ID_NAMES);
  if (sessionIdentifier) return { identifier: sessionIdentifier, source: "session" };

  const promptCacheIdentifier = parseBoundedString(bodyRecord?.prompt_cache_key);
  if (promptCacheIdentifier) {
    return { identifier: promptCacheIdentifier, source: "prompt-cache" };
  }

  return null;
}

function extractText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value : null;
  if (!Array.isArray(value)) return null;

  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      if (item.trim()) parts.push(item);
      continue;
    }
    const itemRecord = asRecord(item);
    const text = itemRecord ? parseBoundedInputText(itemRecord.text) : null;
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function parseBoundedInputText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_INPUT_PREFIX_LENGTH) : null;
}

function firstUserInputText(body: unknown): string | null {
  const bodyRecord = asRecord(body);
  if (!bodyRecord) return null;

  if (typeof bodyRecord.input === "string") {
    return parseBoundedInputText(bodyRecord.input);
  }

  const collections = [bodyRecord.input, bodyRecord.messages];
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      const itemRecord = asRecord(item);
      if (!itemRecord || itemRecord.role !== "user") continue;
      const text = extractText(itemRecord.content ?? itemRecord.text);
      if (text) return text.slice(0, MAX_INPUT_PREFIX_LENGTH);
    }
  }

  return null;
}

function hashIdentity(
  scope: string,
  confidence: "explicit" | "derived",
  identifier: string
): string {
  const tuple = JSON.stringify([SESSION_IDENTITY_VERSION, scope, confidence, identifier]);
  return `session:sha256:${createHash("sha256").update(tuple).digest("hex")}`;
}

/**
 * Resolve a request-scoped identity for account affinity and Codex prompt caching.
 * Raw identifiers are returned only for explicit identities; derived content hashes
 * are internal affinity signals and must never be forwarded upstream.
 */
export function resolveSessionIdentity(
  body: unknown,
  headers: HeaderSource,
  authenticatedApiKeyId: string | null
): ResolvedSessionIdentity {
  const scopeResult = authenticatedScopeSchema.safeParse(authenticatedApiKeyId);
  const scope = scopeResult.success ? scopeResult.data : null;
  const explicit = findExplicitCandidate(body, headers);

  if (explicit) {
    return {
      key: scope ? hashIdentity(scope, "explicit", explicit.identifier) : null,
      source: explicit.source,
      confidence: "explicit",
      upstreamSessionId: explicit.identifier,
    };
  }

  const inputText = firstUserInputText(body);
  if (inputText) {
    return {
      key: scope ? hashIdentity(scope, "derived", inputText) : null,
      source: "input",
      confidence: "derived",
      upstreamSessionId: null,
    };
  }

  return {
    key: null,
    source: "none",
    confidence: "none",
    upstreamSessionId: null,
  };
}
