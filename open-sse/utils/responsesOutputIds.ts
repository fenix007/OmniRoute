import { createHash } from "node:crypto";

const RESPONSES_ID_LIMIT = 64;

function boundedResponsesId(id: string): string {
  const characters = Array.from(id);
  if (characters.length <= RESPONSES_ID_LIMIT) return id;

  // Keep the server-item prefix, and hash the full ID so long response IDs,
  // tool calls, and different output indexes cannot collapse by truncation.
  const suffix = `_${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
  return `${characters.slice(0, RESPONSES_ID_LIMIT - suffix.length).join("")}${suffix}`;
}

export function responsesResponseId(upstreamId: string): string {
  const id = String(upstreamId);
  return boundedResponsesId(id.startsWith("resp_") ? id : `resp_${id}`);
}

export function responsesOutputItemId(
  prefix: "rs" | "msg" | "fc",
  sourceId: string,
  outputIndex?: number | string
): string {
  return boundedResponsesId(
    `${prefix}_${sourceId}${outputIndex === undefined ? "" : `_${outputIndex}`}`
  );
}
