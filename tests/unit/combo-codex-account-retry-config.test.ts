import test from "node:test";
import assert from "node:assert/strict";
import { getDefaultComboConfig, resolveComboConfig } from "../../open-sse/services/comboConfig.ts";
import { createComboSchema } from "../../src/shared/validation/schemas.ts";

test("Codex timeout account retry is opt-in and validated as a boolean", () => {
  assert.equal(getDefaultComboConfig().retryCodexAccountOnTimeout, false);
  assert.equal(
    resolveComboConfig({ config: { retryCodexAccountOnTimeout: true } }).retryCodexAccountOnTimeout,
    true
  );
  for (const value of [true, false]) {
    assert.equal(
      createComboSchema.safeParse({
        name: "coding",
        models: ["codex/gpt-5.6-sol"],
        config: { retryCodexAccountOnTimeout: value },
      }).success,
      true
    );
  }
  assert.equal(
    createComboSchema.safeParse({
      name: "coding",
      models: ["codex/gpt-5.6-sol"],
      config: { retryCodexAccountOnTimeout: "true" },
    }).success,
    false
  );
});
