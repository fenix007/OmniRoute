import crypto from "node:crypto";
import type { CompressionConfig, CompressionMode, CompressionResult } from "./types.ts";

export const MEMO_CAP = 5_000;

export const MEMO_MAX_BYTES = 16 * 1024 * 1024;
export const MEMO_TTL_MS = 5 * 60 * 1000;

interface MemoEntry {
  serialized: string;
  bytes: number;
  expiresAt: number;
}
const memoMap = new Map<string, MemoEntry>();
let memoBytes = 0;

function deleteMemoEntry(key: string): void {
  const entry = memoMap.get(key);
  if (!entry) return;
  memoBytes -= entry.bytes;
  memoMap.delete(key);
}

function purgeExpired(now: number): void {
  for (const [key, entry] of memoMap) {
    if (now >= entry.expiresAt) deleteMemoEntry(key);
  }
}

// Opt-IN whitelist (NOT opt-out): cache only engines proven pure + STATELESS across
// requests. Excluded on purpose: `ccr` and `session-dedup` write to the cross-request
// CCR store (`ccr/index.ts` ccrStore; session-dedup imports storeBlock), so their output
// depends on prior state → not safe to memoize; `ultra`/`aggressive`/`llmlingua` are
// model-backed/non-deterministic. Any NEW engine is excluded until explicitly vetted.
// "omniglyph" is intentionally excluded too (P2 registry-consistency pass): it renders
// context as an image via a model-backed pipeline, so it is not yet proven deterministic
// across requests — conservative default (never-wrong) until explicitly vetted.
const DETERMINISTIC_ENGINES = new Set(["lite", "caveman", "rtk"]);

/** Top-level modes safe to cache (whitelist — any unknown/new mode defaults to false).
 * "omniglyph" intentionally omitted — see comment on DETERMINISTIC_ENGINES above. */
const DETERMINISTIC_MODES = new Set<CompressionMode>(["lite", "standard", "rtk"]);

export function isDeterministicMode(mode: CompressionMode, config?: CompressionConfig): boolean {
  if (mode === "stacked") {
    const pipeline = config?.stackedPipeline;
    if (!pipeline || pipeline.length === 0) return false;
    return pipeline.every((step) => DETERMINISTIC_ENGINES.has(step.engine));
  }
  return DETERMINISTIC_MODES.has(mode);
}

function sha256hex(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function makeMemoKey(
  body: Record<string, unknown>,
  mode: CompressionMode,
  config: CompressionConfig,
  principalId?: string,
  model?: string,
  supportsVision?: boolean | null
): string {
  const bodyHash = sha256hex(JSON.stringify(body));
  // model + supportsVision MUST be part of the key: the `lite` engine strips data:image
  // URLs only when vision is unsupported (replaceImageUrls / modelSupportsVision), so the
  // same (body, config) yields a DIFFERENT result per target — omitting them returns a
  // wrong (image-stripped or image-kept) cached body across vision/non-vision targets.
  return sha256hex(
    JSON.stringify({
      bodyHash,
      mode,
      config,
      principalId: principalId ?? null,
      model: model ?? null,
      supportsVision: supportsVision ?? null,
    })
  );
}

export function memoLookup(key: string): CompressionResult | null {
  const hit = memoMap.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    deleteMemoEntry(key);
    return null;
  }
  // JSON storage avoids retaining the complete object graph and isolates each read.
  return JSON.parse(hit.serialized) as CompressionResult;
}

export function memoStore(key: string, result: CompressionResult): void {
  const serialized = JSON.stringify(result);
  // Conservative UTF-16 accounting covers non-ASCII content and oversized keys.
  const bytes = (serialized.length + key.length) * 2;
  const now = Date.now();
  purgeExpired(now);
  deleteMemoEntry(key);
  // Memoization is optional: large results still reach the client via the caller.
  if (bytes > MEMO_MAX_BYTES) return;
  while (memoMap.size >= MEMO_CAP || memoBytes + bytes > MEMO_MAX_BYTES) {
    const firstKey = memoMap.keys().next().value;
    if (firstKey === undefined) break;
    deleteMemoEntry(firstKey);
  }
  memoMap.set(key, { serialized, bytes, expiresAt: now + MEMO_TTL_MS });
  memoBytes += bytes;
}

/** For tests only — clears the in-process memo store. */
export function clearMemoStore(): void {
  memoMap.clear();
  memoBytes = 0;
}
