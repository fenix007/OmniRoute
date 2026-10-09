// tests/unit/chatcore-executor-client-headers.test.ts
// Characterization of buildExecutorClientHeaders — the executor client-header normalizer extracted
// from handleChatCore (chatCore god-file decomposition, #3501). Locks: Headers and plain-object
// normalization, non-string value skipping, User-Agent backfill (both casings, only when absent),
// and the null-when-empty return.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExecutorClientHeaders } from "../../open-sse/handlers/chatCore/executorClientHeaders.ts";

test("returns null for empty / nullish inputs", () => {
  assert.equal(buildExecutorClientHeaders(null), null);
  assert.equal(buildExecutorClientHeaders(undefined), null);
  assert.equal(buildExecutorClientHeaders({}), null);
});

test("normalizes a Headers instance", () => {
  const h = new Headers({ "X-Test": "1", "content-type": "application/json" });
  const out = buildExecutorClientHeaders(h);
  assert.equal(out?.["content-type"], "application/json");
  assert.equal(out?.["x-test"], "1");
});

test("normalizes a plain object and skips non-string values", () => {
  const out = buildExecutorClientHeaders({ a: "1", b: 2, c: null } as Record<string, unknown>);
  assert.deepEqual(out, { a: "1" });
});

test("backfills the User-Agent in both casings when absent", () => {
  const out = buildExecutorClientHeaders({ a: "1" }, "  MyAgent/1.0  ");
  assert.equal(out?.["user-agent"], "MyAgent/1.0");
  assert.equal(out?.["User-Agent"], "MyAgent/1.0");
});

test("does not overwrite an existing user-agent header", () => {
  const out = buildExecutorClientHeaders({ "user-agent": "Existing/9" }, "MyAgent/1.0");
  assert.equal(out?.["user-agent"], "Existing/9");
  assert.equal(out?.["User-Agent"], undefined);
});

test("a trimmed-empty user agent does not create headers on its own", () => {
  assert.equal(buildExecutorClientHeaders({}, "   "), null);
});

test("Codex metadata identity survives translation through fresh executor headers", () => {
  const headers = { "user-agent": "test", "X-Codex-Session-Id": "invalid\nheader" };
  const body = { metadata: { session_id: "metadata-session" }, prompt_cache_key: "cache-only" };
  const out = buildExecutorClientHeaders(headers, null, body);
  assert.equal(out?.["x-codex-session-id"], "metadata-session");
  assert.equal(out?.["X-Codex-Session-Id"], undefined);
  assert.equal(headers["X-Codex-Session-Id"], "invalid\nheader", "client headers stay unchanged");
  assert.equal(body.prompt_cache_key, "cache-only");
});

test("Codex original header wins and derived user content never becomes an upstream ID", () => {
  assert.equal(
    buildExecutorClientHeaders({ "Session-Id": "header" }, null, {
      session_id: "body",
    })?.["x-codex-session-id"],
    "header"
  );
  assert.equal(buildExecutorClientHeaders(null, null, { input: "user prompt" }), null);
});

test("does not inject a body Unicode session identifier into executor headers", () => {
  const result = buildExecutorClientHeaders(null, "unit-test", {
    metadata: { session_id: "会话-1" },
  });
  assert.equal(result?.["x-codex-session-id"], undefined);
  assert.doesNotThrow(() => new Headers(result ?? {}));
});
