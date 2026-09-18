import test from "node:test";
import assert from "node:assert/strict";

test("usage service opencode errors do not expose stack paths", async () => {
  const { sanitizeErrorMessage } = await import("../../open-sse/utils/error.ts");
  const rawMessage =
    "connection refused\n    at /home/user/open-sse/services/opencodeQuotaFetcher.ts:42:10\n    at /home/user/open-sse/services/usage.ts:890:5";
  const output = `OpenCode error: ${sanitizeErrorMessage(rawMessage)}`;

  assert.match(output, /^OpenCode error:/);
  assert.doesNotMatch(output, /at \/home|\.ts:42|at \//);
});
