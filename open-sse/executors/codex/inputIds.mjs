import { createHash } from "node:crypto";

const CODEX_INPUT_ITEM_ID_LIMIT = 64;
const CODEX_INPUT_ITEM_ID_PREFIXES = new Map([
  ["message", "msg"],
  ["reasoning", "rs"],
  ["function_call", "fc"],
  ["custom_tool_call", "ctc"],
  ["custom_tool_call_output", "ctco"],
]);
const ID_OCCUPIED = 1 << 0;
const ID_PRESERVED = 1 << 1;

function codePoints(value) {
  return Array.from(value);
}

function normalizeCodexInputItemId(item, id) {
  const prefix = CODEX_INPUT_ITEM_ID_PREFIXES.get(item.type);
  if (!prefix || id.length === 0 || id.startsWith(prefix)) return id;
  return `${prefix}_${id}`;
}

function shouldDropCodexEncryptedReasoningItem(item) {
  return (
    item.type === "reasoning" &&
    typeof item.id === "string" &&
    codePoints(item.id).length > CODEX_INPUT_ITEM_ID_LIMIT &&
    typeof item.encrypted_content === "string" &&
    item.encrypted_content.length > 0
  );
}

function codexInputItemIdWithHashSuffix(id, attempt = 0, idCodePoints = codePoints(id)) {
  const hashInput = attempt > 0 ? `${id}\x00${attempt}` : id;
  const suffix = `_${createHash("sha256").update(hashInput).digest("hex").slice(0, 16)}`;
  return `${idCodePoints.slice(0, CODEX_INPUT_ITEM_ID_LIMIT - suffix.length).join("")}${suffix}`;
}

function shortenCodexInputItemId(id, attempt = 0) {
  const idCodePoints = codePoints(id);
  if (idCodePoints.length <= CODEX_INPUT_ITEM_ID_LIMIT) return id;
  return codexInputItemIdWithHashSuffix(id, attempt, idCodePoints);
}

export function sanitizeCodexInputItemIds(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.input)) {
    return body;
  }

  const idStates = new Map();
  for (const item of body.input) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      shouldDropCodexEncryptedReasoningItem(item) ||
      typeof item.id !== "string"
    ) {
      continue;
    }

    const normalizedId = normalizeCodexInputItemId(item, item.id);
    let state = idStates.get(normalizedId) || 0;
    if (normalizedId === item.id) state |= ID_PRESERVED;
    if (codePoints(normalizedId).length <= CODEX_INPUT_ITEM_ID_LIMIT) state |= ID_OCCUPIED;
    if (state !== 0) idStates.set(normalizedId, state);
  }

  const shortenedIds = new Map();
  const collisionIds = new Map();
  const sanitizedInput = [];
  for (const item of body.input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      sanitizedInput.push(item);
      continue;
    }
    if (shouldDropCodexEncryptedReasoningItem(item)) continue;
    if (typeof item.id !== "string") {
      sanitizedInput.push(item);
      continue;
    }

    const originalId = item.id;
    let normalizedId = normalizeCodexInputItemId(item, originalId);
    if (normalizedId !== originalId && (idStates.get(normalizedId) || 0) & ID_PRESERVED) {
      if (!collisionIds.has(normalizedId)) {
        let attempt = 0;
        let collisionId;
        do {
          collisionId = codexInputItemIdWithHashSuffix(normalizedId, attempt);
          attempt += 1;
        } while ((idStates.get(collisionId) || 0) & ID_OCCUPIED);
        collisionIds.set(normalizedId, collisionId);
        idStates.set(collisionId, (idStates.get(collisionId) || 0) | ID_OCCUPIED);
      }
      normalizedId = collisionIds.get(normalizedId);
    }

    if (codePoints(normalizedId).length > CODEX_INPUT_ITEM_ID_LIMIT) {
      if (!shortenedIds.has(normalizedId)) {
        let attempt = 0;
        let shortenedId;
        do {
          shortenedId = shortenCodexInputItemId(normalizedId, attempt);
          attempt += 1;
        } while ((idStates.get(shortenedId) || 0) & ID_OCCUPIED);
        shortenedIds.set(normalizedId, shortenedId);
        idStates.set(shortenedId, (idStates.get(shortenedId) || 0) | ID_OCCUPIED);
      }
      normalizedId = shortenedIds.get(normalizedId);
    }

    sanitizedInput.push(normalizedId === originalId ? item : { ...item, id: normalizedId });
  }

  body.input = sanitizedInput;
  return body;
}
