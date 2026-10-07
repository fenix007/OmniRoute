import test from "node:test";
import assert from "node:assert/strict";
import "../_setup/isolateDataDir.ts";

const { parseUpstreamError } = await import("../../open-sse/utils/error.ts");
function response(header: string, message = "Rate limited", status = 429) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Retry-After": header, "X-Request-Id": "synthetic-request" },
  });
}

test("reject malformed numeric Retry-After rather than parsing a prefix or JS date", async () => {
  for (const value of [
    "38junk",
    "1.5",
    "+38",
    "-1",
    "38, 40",
    "1e3",
    "Infinity",
    "999999999999999999999999",
    "2026-10-08",
  ]) {
    assert.equal((await parseUpstreamError(response(value), "codex")).retryAfterMs, null, value);
  }
});

test("valid delays preserve zero, seconds, 24-hour cap, diagnostics and concurrent isolation", async () => {
  const results = await Promise.all(
    ["0", "38", "00038", " 38 ", "90000"].map((h) =>
      parseUpstreamError(response(h, "Rate limited", 503), "codex")
    )
  );
  assert.deepEqual(
    results.map((x) => x.retryAfterMs),
    [0, 38000, 38000, 38000, 86400000]
  );
  for (const result of results) {
    assert.equal(result.statusCode, 503);
    assert.equal(result.responseHeaders["x-request-id"], "synthetic-request");
  }
});

test("HTTP dates are accepted and elapsed dates mean zero delay", async () => {
  const future = new Date(Date.now() + 60000).toUTCString();
  const parsed = await parseUpstreamError(response(future), "codex");
  assert.ok(parsed.retryAfterMs > 58000 && parsed.retryAfterMs <= 60000);
  assert.equal(
    (await parseUpstreamError(response("Sun, 06 Nov 1994 08:49:37 GMT"), "codex")).retryAfterMs,
    0
  );
});

test("invalid header still permits existing body fallback; valid zero wins", async () => {
  assert.equal(
    (await parseUpstreamError(response("38junk", "Please retry after 20s"), "codex")).retryAfterMs,
    20000
  );
  assert.equal(
    (await parseUpstreamError(response("0", "Please retry after 20s"), "codex")).retryAfterMs,
    0
  );
});

test("all HTTP-date forms use GMT even when the host timezone differs", async () => {
  const { parseRetryAfterHeader } = await import("../../open-sse/utils/retryAfter.ts");
  const now = Date.UTC(1994, 10, 6, 8, 49, 0);
  for (const value of [
    "Sun, 06 Nov 1994 08:49:37 GMT",
    "Sunday, 06-Nov-94 08:49:37 GMT",
    "Sun Nov  6 08:49:37 1994",
  ]) {
    assert.equal(parseRetryAfterHeader(value, now), 37000, value);
  }
});

test("zero and elapsed hints retain the existing downstream default-cooldown contract", async () => {
  const { createErrorResult } = await import("../../open-sse/utils/error.ts");
  for (const hint of ["0", "Sun, 06 Nov 1994 08:49:37 GMT"]) {
    const parsed = await parseUpstreamError(response(hint), "codex");
    const result = createErrorResult(parsed.statusCode, parsed.message, parsed.retryAfterMs);
    assert.equal(
      result.retryAfterMs,
      undefined,
      "no explicit zero-delay cooldown reaches account rotation"
    );
  }
});
