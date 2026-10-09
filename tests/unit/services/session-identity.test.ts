import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { resolveSessionIdentity } from "../../../open-sse/services/sessionIdentity.ts";

function expectedKey(scope: string, confidence: "explicit" | "derived", identifier: string) {
  const digest = createHash("sha256")
    .update(JSON.stringify(["v1", scope, confidence, identifier]))
    .digest("hex");
  return `session:sha256:${digest}`;
}

test("explicit identities are scoped, opaque, and source-independent", () => {
  const fromHeader = resolveSessionIdentity({}, { "X-Codex-Session-Id": " session-1 " }, "key-1");
  const fromBody = resolveSessionIdentity({ session_id: "session-1" }, null, "key-1");

  assert.equal(fromHeader.key, expectedKey("key-1", "explicit", "session-1"));
  assert.equal(fromHeader.key, fromBody.key);
  assert.equal(fromHeader.source, "header");
  assert.equal(fromBody.source, "session");
  assert.equal(fromHeader.confidence, "explicit");
  assert.equal(fromHeader.upstreamSessionId, "session-1");
  assert.match(fromHeader.key || "", /^session:sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(fromHeader.key || "", /session-1|key-1/);
});

test("authenticated scope separates otherwise identical sessions", () => {
  const first = resolveSessionIdentity({ conversation_id: "conversation-1" }, null, "key-1");
  const second = resolveSessionIdentity({ conversation_id: "conversation-1" }, null, "key-2");

  assert.notEqual(first.key, second.key);
  assert.equal(first.source, "conversation");
  assert.equal(first.upstreamSessionId, "conversation-1");
});

test("missing or invalid authenticated scope disables the affinity key", () => {
  const missing = resolveSessionIdentity({ session_id: "session-1" }, null, null);
  const oversized = resolveSessionIdentity({ session_id: "session-1" }, null, "a".repeat(257));

  assert.deepEqual(missing, {
    key: null,
    source: "session",
    confidence: "explicit",
    upstreamSessionId: "session-1",
  });
  assert.equal(oversized.key, null);
  assert.equal(oversized.upstreamSessionId, "session-1");
});

test("header aliases take priority over body identities", () => {
  for (const name of [
    "x-codex-session-id",
    "x-session-id",
    "x-omniroute-session",
    "x-omniroute-session-id",
    "session_id",
    "session-id",
    "conversation",
    "conversation_id",
    "thread_id",
    "thread-id",
  ]) {
    const result = resolveSessionIdentity(
      { metadata: { session_id: "metadata-session" }, conversation_id: "body-session" },
      { [name]: "header-session" },
      "key-1"
    );
    assert.equal(result.source, "header", name);
    assert.equal(result.upstreamSessionId, "header-session", name);
  }
});

test("body priority is metadata, conversation, session, then prompt_cache_key", () => {
  const metadata = resolveSessionIdentity(
    {
      metadata: { thread: "metadata-thread" },
      conversation_id: "conversation-1",
      session_id: "session-1",
      prompt_cache_key: "cache-1",
    },
    null,
    "key-1"
  );
  const conversation = resolveSessionIdentity(
    { conversation: "conversation-1", session_id: "session-1", prompt_cache_key: "cache-1" },
    null,
    "key-1"
  );
  const session = resolveSessionIdentity(
    { "session-id": "session-1", prompt_cache_key: "cache-1" },
    null,
    "key-1"
  );
  const promptCache = resolveSessionIdentity({ prompt_cache_key: "cache-1" }, null, "key-1");

  assert.equal(metadata.source, "metadata");
  assert.equal(metadata.upstreamSessionId, "metadata-thread");
  assert.equal(conversation.source, "conversation");
  assert.equal(session.source, "session");
  assert.equal(promptCache.source, "prompt-cache");
});

test("derived identity uses only the first user message and is never forwarded", () => {
  const body = {
    input: [
      { role: "system", content: "shared prefix" },
      { role: "developer", content: "shared developer prefix" },
      {
        role: "user",
        content: [
          { type: "input_text", text: "first user text" },
          { type: "input_image", image_url: "data:image/png;base64,abc" },
        ],
      },
      { role: "user", content: "second user text" },
    ],
  };
  const result = resolveSessionIdentity(body, null, "key-1");

  assert.deepEqual(result, {
    key: expectedKey("key-1", "derived", "first user text"),
    source: "input",
    confidence: "derived",
    upstreamSessionId: null,
  });
});

test("derived input is bounded to 4096 characters", () => {
  const prefix = "a".repeat(4096);
  const first = resolveSessionIdentity(
    { messages: [{ role: "user", content: prefix }] },
    null,
    "k"
  );
  const second = resolveSessionIdentity(
    { messages: [{ role: "user", content: `${prefix}ignored suffix` }] },
    null,
    "k"
  );

  assert.equal(first.key, second.key);
  assert.equal(first.upstreamSessionId, null);
});

test("system-only input and oversized explicit identifiers do not create identity", () => {
  const result = resolveSessionIdentity(
    {
      session_id: "s".repeat(513),
      input: [{ role: "system", content: "shared prefix" }],
    },
    null,
    "key-1"
  );

  assert.deepEqual(result, {
    key: null,
    source: "none",
    confidence: "none",
    upstreamSessionId: null,
  });
});

test("explicit identifiers containing control characters are rejected", () => {
  const fromBody = resolveSessionIdentity({ session_id: "bad\r\nsession" }, null, "key-1");
  const fromHeader = resolveSessionIdentity({}, { session_id: "bad\u0000session" }, "key-1");

  assert.equal(fromBody.source, "none");
  assert.equal(fromBody.upstreamSessionId, null);
  assert.equal(fromHeader.source, "none");
  assert.equal(fromHeader.upstreamSessionId, null);
});

test("unsafe upstream identifiers retain scoped affinity without entering headers", () => {
  for (const identifier of ["会话-1", "session with spaces", "a".repeat(201)]) {
    const identity = resolveSessionIdentity(
      { metadata: { session_id: identifier } },
      null,
      "key-1"
    );
    assert.equal(identity.key, expectedKey("key-1", "explicit", identifier));
    assert.equal(identity.upstreamSessionId, null);
    assert.equal(identity.source, "metadata");
  }
});
