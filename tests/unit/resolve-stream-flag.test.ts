// Port of upstream #2081 — forceStream (stream-only) providers must keep streaming even
// when the client asks for a non-streaming/JSON response. OmniRoute then accumulates the
// provider stream and returns a normal JSON body to the client (handleForcedSSEToJson).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveStreamFlag } from "../../open-sse/utils/aiSdkCompat.ts";

describe("resolveStreamFlag — forceStream / providerRequiresStreaming guard (#2081)", () => {
  it("keeps streaming for a forceStream provider even when client prefers JSON and sets stream:false", () => {
    // The bug: Accept: application/json + stream:false used to override providerRequiresStreaming,
    // sending stream:false to a stream-only provider (e.g. CodeBuddy) → HTTP 400.
    const result = resolveStreamFlag(
      false, // body.stream = false
      "application/json", // Accept header
      undefined, // sourceFormat
      { providerRequiresStreaming: true }
    );
    assert.equal(
      result,
      true,
      "stream-only provider must stay streaming even when client prefers JSON"
    );
  });

  it("non-forceStream provider: client prefers JSON + stream:false → non-streaming (unchanged behavior)", () => {
    const result = resolveStreamFlag(false, "application/json", undefined, {
      providerRequiresStreaming: false,
    });
    assert.equal(result, false, "normal provider should respect client JSON preference");
  });

  it("forceStream provider: no explicit stream flag → streams by default", () => {
    const result = resolveStreamFlag(undefined, undefined, undefined, {
      providerRequiresStreaming: true,
    });
    assert.equal(result, true);
  });

  it("ordinary provider with no special flags streams by default (backward compat)", () => {
    const result = resolveStreamFlag(undefined, undefined);
    assert.equal(result, true);
  });

  it("forceStream provider: client explicitly sends stream:true → stays true", () => {
    const result = resolveStreamFlag(true, "application/json", undefined, {
      providerRequiresStreaming: true,
    });
    assert.equal(result, true);
  });

  it("forceStream provider: client sends Accept: text/event-stream + stream:false → stays true", () => {
    // SSE Accept header alone shouldn't be needed for stream-only providers,
    // but providerRequiresStreaming should still force true.
    const result = resolveStreamFlag(false, "text/event-stream", undefined, {
      providerRequiresStreaming: true,
    });
    assert.equal(result, true);
  });

  it("without providerRequiresStreaming option, JSON client + stream:false still gets non-streaming", () => {
    // Verify backward compatibility — no regression for callers that don't pass the option
    const result = resolveStreamFlag(false, "application/json");
    assert.equal(result, false);
  });
});

describe("resolveStreamFlag — global stream default via OMNIROUTE_STREAM_DEFAULT_MODE", () => {
  const ENV_VAR = "OMNIROUTE_STREAM_DEFAULT_MODE";

  function withEnv(value: string | undefined, fn: () => void) {
    const previous = process.env[ENV_VAR];
    if (value === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = value;
    try {
      fn();
    } finally {
      if (previous === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = previous;
    }
  }

  // A machine client (python-httpx et al.) omits `stream` and sends a wildcard Accept.
  // The legacy default streams it, so an upstream failure arrives as an in-band error
  // frame inside a committed 200 that the client reads as an empty success.
  it("legacy default still streams a wildcard-Accept client that omits stream", () => {
    withEnv(undefined, () => {
      assert.equal(resolveStreamFlag(undefined, "*/*"), true);
    });
  });

  it("env json mode routes that same client through the JSON path", () => {
    withEnv("json", () => {
      assert.equal(resolveStreamFlag(undefined, "*/*"), false);
    });
  });

  it("explicit body stream and SSE Accept still win over the env default", () => {
    withEnv("json", () => {
      assert.equal(resolveStreamFlag(true, "*/*"), true);
      assert.equal(resolveStreamFlag(undefined, "text/event-stream"), true);
    });
  });

  it("an explicit per-key mode overrides the env default in both directions", () => {
    withEnv("json", () => {
      assert.equal(
        resolveStreamFlag(undefined, "*/*", undefined, { streamDefaultMode: "legacy" }),
        true
      );
    });
    withEnv(undefined, () => {
      assert.equal(
        resolveStreamFlag(undefined, "*/*", undefined, { streamDefaultMode: "json" }),
        false
      );
    });
  });

  it("ignores an unrecognized env value", () => {
    withEnv("yes", () => {
      assert.equal(resolveStreamFlag(undefined, "*/*"), true);
    });
  });
});
