/**
 * Strip server-generated item IDs from the input array.
 *
 * The Codex /codex/responses endpoint does not persist response items even when
 * store=true is sent. When proxy clients (e.g. OpenClaw) include response items
 * from previous turns in the input array, those items carry server-assigned IDs
 * (prefixed with "rs_", "fc_", "resp_", "msg_"). The Codex backend tries to
 * validate these IDs against its persistence store and returns 404 when the items
 * are not found (because store was effectively false).
 *
 * This function:
 *   1. Removes bare string references ("rs_abc123") from the input array
 *   2. Removes object items with type "item_reference" (explicit stored-item refs)
 *   3. Strips the "id" field from any object in input whose id matches a
 *      server-generated prefix (rs_, fc_, resp_, msg_) — so the content is
 *      preserved but the backend won't try to look it up
 */
export function stripStoredItemReferences(body: Record<string, unknown>): void {
  if (Array.isArray(body.input) && body.input.length === 0) {
    body.input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue" }],
      },
    ];
  }

  if (!Array.isArray(body.input)) return;

  const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;
  let strippedCount = 0;

  body.input = body.input.filter((item) => {
    if (typeof item === "string" && SERVER_ID_PATTERN.test(item)) {
      strippedCount++;
      return false;
    }

    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === "item_reference"
    ) {
      strippedCount++;
      return false;
    }

    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === "reasoning"
    ) {
      strippedCount++;
      return false;
    }

    if (item && typeof item === "object" && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      if (typeof record.id === "string" && SERVER_ID_PATTERN.test(record.id)) {
        delete record.id;
        strippedCount++;
      }
    }

    return true;
  });

  if (strippedCount > 0) {
    console.debug(
      `[Codex] stripStoredItemReferences: sanitized ${strippedCount} server-generated ID(s) from input`
    );
  }
}
