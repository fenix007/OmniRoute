import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatAppVersion } from "../../src/shared/constants/appConfig.ts";

describe("formatAppVersion", () => {
  it("keeps the upstream version label for ordinary builds", () => {
    assert.equal(formatAppVersion("3.8.48"), "v3.8.48");
  });

  it("adds the concise fork release suffix for tagged fork builds", () => {
    assert.equal(formatAppVersion("3.8.48", "3.8.48-fork.17"), "v3.8.48 · fork.17");
  });

  it("preserves a mismatched build identifier so version drift stays visible", () => {
    assert.equal(formatAppVersion("3.8.48", "v3.8.49-fork.1"), "v3.8.48 · 3.8.49-fork.1");
  });
});
