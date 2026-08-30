import assert from "node:assert/strict";
import test from "node:test";

import { isTerminalCodexOAuthFailure } from "../../open-sse/handlers/chatCore/codexAuthFailure.ts";

test("detects Codex invalidated OAuth 401 messages", () => {
  assert.equal(
    isTerminalCodexOAuthFailure({
      provider: "codex",
      status: 401,
      message: "[401]: Encountered invalidated oauth token for user, failing request",
    }),
    true
  );
  assert.equal(
    isTerminalCodexOAuthFailure({
      provider: "codex",
      status: 401,
      responseBody: {
        error: { message: "Authentication token has been invalidated" },
      },
    }),
    true
  );
});

test("does not skip refresh for recoverable or unrelated authentication failures", () => {
  assert.equal(
    isTerminalCodexOAuthFailure({
      provider: "codex",
      status: 401,
      message: "Provided authentication token is expired",
    }),
    false
  );
  assert.equal(
    isTerminalCodexOAuthFailure({
      provider: "codex",
      status: 403,
      message: "Encountered invalidated oauth token",
    }),
    false
  );
  assert.equal(
    isTerminalCodexOAuthFailure({
      provider: "claude",
      status: 401,
      message: "Encountered invalidated oauth token",
    }),
    false
  );
});
