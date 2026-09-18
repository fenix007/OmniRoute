import { test } from "node:test";
import assert from "node:assert/strict";
import {
  intersectAllowedConnectionIds,
  hasNonObjectMessageEntry,
  readResponseErrorReason,
} from "../../src/sse/handlers/chatRequestUtils.ts";

test("connection scopes retain deny-all intersections and ignore absent scopes", () => {
  assert.deepEqual(intersectAllowedConnectionIds(["account-a"], ["account-b"]), []);
  assert.deepEqual(intersectAllowedConnectionIds(["account-a", "account-b"], ["account-b"]), [
    "account-b",
  ]);
  assert.deepEqual(intersectAllowedConnectionIds(null, ["account-a", "", null, 12]), ["account-a"]);
  assert.deepEqual(intersectAllowedConnectionIds(["account-a"], undefined), ["account-a"]);
  assert.equal(intersectAllowedConnectionIds([], null), null);
});

test("message validation rejects nulls, arrays and scalars without rejecting object payloads", () => {
  for (const invalid of [null, [], "message", 1, true]) {
    assert.equal(hasNonObjectMessageEntry([{ role: "user", content: "hi" }, invalid]), true);
  }
  assert.equal(hasNonObjectMessageEntry([{ role: "user", content: [] }]), false);
  assert.equal(hasNonObjectMessageEntry([]), false);
});

test("reading a terminal error preserves its response body for the caller", async () => {
  const body = { error: { message: "  Model timeout: combo-per-model-timeout  " } };
  const response = Response.json(body, { status: 499 });
  assert.equal(await readResponseErrorReason(response), "Model timeout: combo-per-model-timeout");
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(await response.json(), body);
});

test("malformed or non-message error payloads retain the null fallback", async () => {
  for (const body of [
    { error: { message: "  " } },
    { error: { message: 7 } },
    { error: "oops" },
    {},
  ]) {
    assert.equal(await readResponseErrorReason(Response.json(body)), null);
  }
  assert.equal(await readResponseErrorReason(new Response("not json", { status: 502 })), null);
  const consumed = Response.json({ error: { message: "consumed" } });
  await consumed.text();
  assert.equal(await readResponseErrorReason(consumed), null);
});
