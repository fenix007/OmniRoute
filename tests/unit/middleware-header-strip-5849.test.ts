import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildStreamingResponseHeaders,
  isCodexAccountQuotaHeader,
  isNextMiddlewareControlHeader,
  shouldHideCodexAccountQuotaHeaders,
  stripCodexAccountQuotaHeaders,
  stripNextMiddlewareControlHeaders,
} from "@omniroute/open-sse/handlers/chatCore/responseHeaders.ts";

// Regression guard for issue #5849:
// Providers hosted behind a Next.js middleware (e.g. synthetic.new) leak Next's
// internal `x-middleware-*` control headers on a successful 200 response.
// Forwarding `x-middleware-rewrite` verbatim from an App Router route handler
// makes Next 16 throw `NextResponse.rewrite() was used in a app route handler`
// and return 500. Both proxy paths (streaming + JSON) must strip the family.

const MIDDLEWARE_HEADERS: [string, string][] = [
  ["x-middleware-rewrite", "/internal/rewrite"],
  ["x-middleware-next", "1"],
  ["x-middleware-override-headers", "x-foo"],
  ["x-middleware-set-cookie", "a=b"],
  ["x-middleware-request-foo", "bar"],
];

test("isNextMiddlewareControlHeader matches the whole x-middleware-* family (case-insensitive)", () => {
  for (const [name] of MIDDLEWARE_HEADERS) {
    assert.equal(isNextMiddlewareControlHeader(name), true, name);
    assert.equal(isNextMiddlewareControlHeader(name.toUpperCase()), true, name);
  }
  assert.equal(isNextMiddlewareControlHeader("x-request-id"), false);
  assert.equal(isNextMiddlewareControlHeader("content-type"), false);
});

test("streaming path: buildStreamingResponseHeaders strips x-middleware-* and preserves normal headers", () => {
  const upstream = new Headers();
  for (const [k, v] of MIDDLEWARE_HEADERS) upstream.append(k, v);
  upstream.append("x-request-id", "req-123");

  const out = buildStreamingResponseHeaders(upstream, {});

  const lowerKeys = Object.keys(out).map((k) => k.toLowerCase());
  for (const [name] of MIDDLEWARE_HEADERS) {
    assert.ok(
      !lowerKeys.includes(name.toLowerCase()),
      `expected ${name} to be stripped, got: ${lowerKeys.join(", ")}`
    );
  }
  // Normal upstream header preserved.
  const requestIdKey = Object.keys(out).find((k) => k.toLowerCase() === "x-request-id");
  assert.ok(requestIdKey, "x-request-id must be preserved");
  assert.equal(out[requestIdKey as string], "req-123");
});

test("non-streaming JSON path: stripNextMiddlewareControlHeaders removes the family, keeps the rest", () => {
  const headers = new Headers();
  for (const [k, v] of MIDDLEWARE_HEADERS) headers.append(k, v);
  headers.append("x-request-id", "req-456");
  headers.append("content-type", "application/json");

  stripNextMiddlewareControlHeaders(headers);

  for (const [name] of MIDDLEWARE_HEADERS) {
    assert.equal(headers.get(name), null, `${name} must be stripped`);
  }
  assert.equal(headers.get("x-request-id"), "req-456");
  assert.equal(headers.get("content-type"), "application/json");
});

test("Codex account quota headers are hidden only for coding profiles", () => {
  const quotaHeaders = [
    "x-codex-primary-used-percent",
    "x-codex-primary-window-minutes",
    "x-codex-primary-reset-at",
    "x-codex-secondary-used-percent",
    "x-codex-credits-balance",
    "x-codex-plan-type",
    "x-codex-rate-limit-reached-type",
  ];
  const upstream = new Headers({
    "x-codex-turn-state": "protocol-state",
    "x-request-id": "req-codex-quota",
  });
  for (const name of quotaHeaders) upstream.set(name, "1");

  const streaming = buildStreamingResponseHeaders(upstream, {}, "coding-high");
  for (const name of quotaHeaders) {
    assert.equal(isCodexAccountQuotaHeader(name), true, name);
    assert.equal(
      Object.keys(streaming).some((key) => key.toLowerCase() === name),
      false,
      `${name} must not describe the selected backend account to the client`
    );
  }
  assert.equal(streaming["x-codex-turn-state"], "protocol-state");
  assert.equal(streaming["x-request-id"], "req-codex-quota");

  stripCodexAccountQuotaHeaders(upstream, "coding-high");
  for (const name of quotaHeaders) assert.equal(upstream.get(name), null, name);
  assert.equal(upstream.get("x-codex-turn-state"), "protocol-state");
  assert.equal(upstream.get("x-request-id"), "req-codex-quota");

  assert.equal(shouldHideCodexAccountQuotaHeaders("coding"), true);
  assert.equal(shouldHideCodexAccountQuotaHeaders("coding-low"), true);
  assert.equal(shouldHideCodexAccountQuotaHeaders("coding-fast"), true);
  assert.equal(shouldHideCodexAccountQuotaHeaders("coding-high"), true);
  assert.equal(shouldHideCodexAccountQuotaHeaders("coding-custom"), false);
  assert.equal(shouldHideCodexAccountQuotaHeaders("gpt-5.6-sol"), false);
});

test("Codex account quota headers remain visible for non-coding models", () => {
  const upstream = new Headers({
    "x-codex-primary-used-percent": "81",
    "x-codex-turn-state": "protocol-state",
  });

  const streaming = buildStreamingResponseHeaders(upstream, {}, "gpt-5.6-sol");
  assert.equal(streaming["x-codex-primary-used-percent"], "81");

  stripCodexAccountQuotaHeaders(upstream, "gpt-5.6-sol");
  assert.equal(upstream.get("x-codex-primary-used-percent"), "81");
});

test("coding combo name takes precedence over the resolved target model", () => {
  const upstream = new Headers({ "x-codex-primary-used-percent": "81" });

  const streaming = buildStreamingResponseHeaders(upstream, {}, "openai/gpt-5.6-sol", "coding");

  assert.equal(streaming["x-codex-primary-used-percent"], undefined);
});
