import { createHash } from "node:crypto";
import type { JsonRecord } from "./helpers.ts";

const LIMIT = 64;

/** Map complete Chat history before clamping loses the original tool IDs. */
export function normalizeChatCallIds(input: JsonRecord[]): void {
  const occupied = new Set<string>();
  const mapped = new Map<string, string>();
  for (const item of input) {
    if (typeof item.call_id === "string" && item.call_id.length <= LIMIT) {
      occupied.add(item.call_id);
    }
  }
  for (const item of input) {
    const original = item.call_id;
    if (typeof original !== "string" || original.length <= LIMIT) continue;
    if (!mapped.has(original)) {
      let candidate: string;
      let attempt = 0;
      do {
        const hash = createHash("sha256").update(Buffer.from(original, "utf16le"));
        if (attempt > 0) hash.update(`\0${attempt}`);
        const suffix = `_${hash.digest("hex").slice(0, 16)}`;
        let prefix = "";
        for (const point of original.toWellFormed()) {
          if (Buffer.byteLength(prefix + point, "utf8") > LIMIT - suffix.length) break;
          prefix += point;
        }
        candidate = prefix + suffix;
        attempt++;
      } while (occupied.has(candidate));
      mapped.set(original, candidate);
      occupied.add(candidate);
    }
    item.call_id = mapped.get(original)!;
  }
}
