import test from "node:test";
import assert from "node:assert/strict";
import {
  isRetryablePreOutputTransportError,
  shouldRetrySameAccountTransport,
} from "../../src/sse/services/sameAccountTransportRetry.ts";
import { parseUpstreamError } from "../../open-sse/utils/error.ts";

for (const status of [400, 401, 429, 503]) {
  test(`Gemini numeric error code ${status} survives upstream parsing and retry classification`, async () => {
    const parsed = await parseUpstreamError(
      new Response(
        JSON.stringify({
          error: {
            code: status,
            message: status === 429 ? "Quota exceeded for API requests" : "Upstream error",
            status: status === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE",
          },
        }),
        { status, headers: { "Content-Type": "application/json" } }
      ),
      "gemini"
    );
    assert.equal(parsed.errorCode, status);
    assert.equal(
      shouldRetrySameAccountTransport({
        status: parsed.statusCode,
        errorText: parsed.message,
        errorCode: parsed.errorCode,
        errorType: parsed.errorType as string,
        attempt: 0,
      }),
      status === 503
    );
  });
}

test("non-string upstream metadata preserves status classification without throwing", () => {
  for (const code of [429, { code: 429 }, [429], true, null, undefined]) {
    assert.equal(isRetryablePreOutputTransportError(429, "Quota exceeded", code), false);
    assert.equal(isRetryablePreOutputTransportError(502, "Bad Gateway", code), true);
  }
});

test("model and lease string codes still bypass transport retries", () => {
  for (const code of ["MODEL_ERROR", "overloaded_error", "empty_response", "LEASE_EXPIRED"]) {
    assert.equal(isRetryablePreOutputTransportError(503, "Upstream error", code), false);
  }
  assert.equal(
    isRetryablePreOutputTransportError(503, "Upstream error", 503, "lease_error"),
    false
  );
});
