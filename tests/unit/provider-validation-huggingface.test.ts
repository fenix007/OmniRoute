import test from "node:test";
import assert from "node:assert/strict";

const { validateProviderApiKey } = await import("../../src/lib/providers/validation.ts");

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function toPlainHeaders(headers: HeadersInit | undefined) {
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [key, String(value)])
  );
}

// Fine-grained HF Inference-Provider tokens are valid even when model/task
// endpoints reject them. The validator must probe whoami-v2 as a pure auth
// check: only 401/403 is invalid; any other non-OK status is transient.
test("huggingface validator accepts a token whoami-v2 recognizes", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: toPlainHeaders(init.headers) });
    return new Response(JSON.stringify({ name: "hf-user", auth: { type: "access_token" } }), {
      status: 200,
    });
  };

  const result = await validateProviderApiKey({ provider: "huggingface", apiKey: "hf_validtoken" });

  assert.equal(result.valid, true);
  assert.equal(result.error, null);
  assert.equal(result.method, "huggingface_whoami");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://huggingface.co/api/whoami-v2");
  assert.equal(calls[0].headers.Authorization, "Bearer hf_validtoken");
});

test("huggingface validator treats 401/403 as an invalid token", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const unauthorized = await validateProviderApiKey({ provider: "huggingface", apiKey: "hf_bad" });
  assert.equal(unauthorized.valid, false);
  assert.equal(unauthorized.error, "Invalid API key");

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
  const forbidden = await validateProviderApiKey({ provider: "huggingface", apiKey: "hf_bad" });
  assert.equal(forbidden.valid, false);
  assert.equal(forbidden.error, "Invalid API key");
});

test("huggingface validator does NOT mark a fine-grained token invalid on a non-auth status", async () => {
  // This is the false-negative the port fixes: a 503/404 from a model/task
  // probe used to read as "invalid key". whoami-v2 returning a non-auth,
  // non-OK status must surface as a transient error, never "Invalid API key".
  globalThis.fetch = async () => new Response("upstream down", { status: 503 });

  const result = await validateProviderApiKey({
    provider: "huggingface",
    apiKey: "hf_finegrained",
  });

  assert.equal(result.valid, false);
  assert.notEqual(result.error, "Invalid API key");
  assert.match(result.error || "", /HuggingFace token check returned 503/);
});
