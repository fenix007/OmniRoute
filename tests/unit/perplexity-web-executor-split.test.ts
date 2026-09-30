import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Split-guard for the perplexity-web executor protocol extraction.
// The pure wire protocol (consts, types, SSE parsing, request/query building, content
// extraction) lives in protocol.ts and wire.ts (no host state/fetch/auth). The original
// protocol entry point re-exports the wire helpers so host/client imports stay stable.
const HERE = dirname(fileURLToPath(import.meta.url));
const EXE = join(HERE, "../../open-sse/executors");
const HOST = join(EXE, "perplexity-web.ts");
const LEAF = join(EXE, "perplexity-web/protocol.ts");
const WIRE = join(EXE, "perplexity-web/wire.ts");

test("protocol modules host their helpers without importing the host", () => {
  const protocol = readFileSync(LEAF, "utf8");
  const wire = readFileSync(WIRE, "utf8");
  for (const [src, symbols] of [
    [protocol, ["extractContent", "sseChunk"]],
    [wire, ["cleanResponse", "buildPplxRequestBody"]],
  ] as const) {
    for (const sym of symbols) {
      assert.match(src, new RegExp(`export (async function\\*?|function\\*?|const) ${sym}\\b`));
    }
    assert.doesNotMatch(src, /from "\.\.\/perplexity-web\.ts"/);
  }
  assert.match(protocol, /export \* from "\.\/wire\.ts"/);
  assert.doesNotMatch(wire, /from "\.\/protocol\.ts"/);
});

test("host imports the protocol helpers back from the leaf", () => {
  const host = readFileSync(HOST, "utf8");
  assert.match(host, /from "\.\/perplexity-web\/protocol\.ts"/);
});

test("cleanResponse strips citations and sseChunk formats a chunk", async () => {
  const { cleanResponse, sseChunk } =
    await import("../../open-sse/executors/perplexity-web/protocol.ts");
  assert.equal(typeof cleanResponse("hello", true), "string");
  assert.match(sseChunk({ a: 1 }), /^data: \{"a":1\}\n\n$/);
});
