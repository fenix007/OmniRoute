import test from "node:test";
import assert from "node:assert/strict";

const { normalizeUpstreamFailure } =
  await import("../../open-sse/translator/response/openai-responses/pureHelpers.ts");
const { checkFallbackError } = await import("../../open-sse/services/accountFallback.ts");

const POLICY_MESSAGE =
  "Invalid prompt: your prompt was flagged as potentially violating our usage policy.";

test("normalizes a structured invalid_prompt rejection as a non-retryable 400", () => {
  const result = normalizeUpstreamFailure({
    response: {
      error: {
        code: "invalid_prompt",
        message: POLICY_MESSAGE,
      },
    },
  });

  assert.deepEqual(result, {
    status: 400,
    type: "invalid_request_error",
    code: "invalid_prompt",
    message: POLICY_MESSAGE,
  });

  const fallback = checkFallbackError(result.status, result.message, 0, null, "codex", null, null, {
    code: result.code,
    type: result.type,
  });
  assert.equal(fallback.shouldFallback, false);
  assert.equal(fallback.cooldownMs, 0);
});

test("recognizes a usage-policy rejection when upstream omits the error code", () => {
  const result = normalizeUpstreamFailure({ message: POLICY_MESSAGE });

  assert.deepEqual(result, {
    status: 400,
    type: "invalid_request_error",
    code: "invalid_prompt",
    message: POLICY_MESSAGE,
  });
});

test("preserves a structured content_policy_violation code while mapping it to 400", () => {
  const result = normalizeUpstreamFailure({
    error: {
      code: "content_policy_violation",
      message: "Request rejected by the content policy.",
    },
  });

  assert.equal(result.status, 400);
  assert.equal(result.type, "invalid_request_error");
  assert.equal(result.code, "content_policy_violation");
});

test("keeps unrelated upstream failures as 502 bad_gateway", () => {
  const result = normalizeUpstreamFailure({ message: "Upstream connection closed unexpectedly" });

  assert.equal(result.status, 502);
  assert.equal(result.type, "server_error");
  assert.equal(result.code, "bad_gateway");
});
