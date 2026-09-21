import assert from "node:assert/strict";
import { getMemoryExtractionQueueStats } from "../../src/lib/memory/extraction.ts";

export async function waitForAsyncMemoryFlush() {
  const deadline = performance.now() + 5_000;
  // Each queued extraction may require another event-loop turn. Wait for completion,
  // not a fixed delay; the callers still assert the exact persisted memories.
  while (true) {
    const { active, queued } = getMemoryExtractionQueueStats();
    if (active === 0 && queued === 0) return;
    assert.ok(
      performance.now() < deadline,
      `Memory extraction did not drain: ${active} active, ${queued} queued`
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
