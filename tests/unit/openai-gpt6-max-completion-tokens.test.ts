import test from "node:test";
import assert from "node:assert/strict";

import { supportsMaxTokens } from "../../src/lib/modelCapabilities.ts";

// OpenAI returns HTTP 400 "Unsupported parameter: 'max_tokens'" for gpt-5.6 and the
// gpt-6 family, so chatCore must rename max_tokens to max_completion_tokens for them.
test("gpt-5.6 and gpt-6 family do not support max_tokens", () => {
  for (const model of ["gpt-5.6-sol", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-astra"]) {
    assert.equal(supportsMaxTokens({ provider: "openai", model }), false, model);
  }
});

test("older chat models keep max_tokens", () => {
  for (const model of ["gpt-4o", "gpt-4.1-mini", "claude-haiku-4.5"]) {
    assert.equal(supportsMaxTokens({ provider: "openai", model }), true, model);
  }
});
