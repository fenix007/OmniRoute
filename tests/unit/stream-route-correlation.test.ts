import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { withEarlyStreamKeepalive } from "../../open-sse/utils/earlyStreamKeepalive.ts";

// Run the real route with only its handler/DB boundaries stubbed. The keepalive
// implementation is real so a late header cannot accidentally satisfy the test.
async function loadRoute(route: string, handler: (...args: unknown[]) => Promise<Response>) {
  const source = await readFile(
    new URL(`../../src/app/api/v1/${route}/route.ts`, import.meta.url),
    "utf8"
  );
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let generated = 0;
  const modules = {
    "@/sse/handlers/chat": { handleChat: handler },
    "@/shared/utils/requestId": { generateRequestId: () => `route-id-${++generated}` },
    "@/middleware/promptInjectionGuard": { withInjectionGuard: (fn: unknown) => fn },
    "@/shared/middleware/requireJsonContentType": { requireJsonContentType: () => null },
    "@/app/api/internal/codex-responses-ws/modelResolution": {
      resolveResponsesApiModel: async (model: string) => ({ model, changed: false }),
    },
    "@/sse/services/model": { getModelInfo: () => null },
    "@/lib/db/combos": { getComboByName: async () => null },
    "@omniroute/open-sse/translator/index.ts": { initTranslators: async () => {} },
    "@omniroute/open-sse/utils/keepaliveThreshold": { resolveKeepaliveThreshold: () => 1 },
    "@omniroute/open-sse/utils/earlyStreamKeepalive":
      await import("../../open-sse/utils/earlyStreamKeepalive.ts"),
  };
  const exports: { POST?: (request: Request, context: object, body: object) => Promise<Response> } =
    {};
  runInNewContext(code, {
    exports,
    Request,
    Response,
    console: { log() {} },
    require(name: string) {
      assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
      return modules[name as keyof typeof modules];
    },
  });
  return { post: exports.POST!, generated: () => generated };
}

for (const route of ["responses", "messages"]) {
  for (const failed of [false, true]) {
    test(`${route}: slow ${failed ? "failure" : "completion"} keeps the handler correlation ID`, async () => {
      let resolve!: (response: Response) => void;
      let handlerId: unknown;
      const pending = new Promise<Response>((done) => {
        resolve = done;
      });
      const loaded = await loadRoute(route, async (_request, _session, _body, id) => {
        handlerId = id;
        return pending;
      });
      const response = await loaded.post(
        new Request(`http://localhost/v1/${route}`, {
          method: "POST",
          headers: { accept: "text/event-stream" },
        }),
        {},
        { model: "coding", stream: true }
      );

      assert.equal(loaded.generated(), 1);
      assert.equal(response.headers.get("x-correlation-id"), handlerId);
      assert.equal(handlerId, "route-id-1");
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      assert.match(first, route === "messages" ? /event: ping/ : /: omniroute-keepalive/);
      const raw =
        route === "responses"
          ? 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'
          : 'data: {"type":"message_stop"}\n\n';
      resolve(
        failed
          ? Response.json({ error: { message: "overloaded" } }, { status: 502 })
          : new Response(raw, {
              headers: {
                "content-type": "text/event-stream",
                "x-correlation-id": String(handlerId),
              },
            })
      );
      let body = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        body += new TextDecoder().decode(value);
      }
      if (failed) {
        assert.match(body, route === "responses" ? /event: response.failed/ : /event: error/);
        assert.match(body, /overloaded/);
      } else assert.equal(body, raw);
      assert.equal(response.headers.get("x-correlation-id"), handlerId);
    });
  }

  test(`${route}: non-streaming path preserves response and parsed body`, async () => {
    const original = Response.json({ status: "completed" });
    const payload = { model: "coding", stream: false };
    const loaded = await loadRoute(route, async (_request, _session, body, id) => {
      assert.equal(body, payload);
      assert.equal(id, undefined);
      return original;
    });
    assert.equal(
      await loaded.post(
        new Request(`http://localhost/v1/${route}`, {
          method: "POST",
          headers: { accept: "application/json" },
        }),
        {},
        payload
      ),
      original
    );
    assert.equal(loaded.generated(), 0);
  });
}

test("fast keepalive response retains its original correlation header and bytes", async () => {
  const original = new Response("data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream", "x-correlation-id": "handler-id" },
  });
  const response = await withEarlyStreamKeepalive(Promise.resolve(original), {
    thresholdMs: 1000,
    extraHeaders: { "X-Correlation-Id": "handler-id" },
  });
  assert.equal(response, original);
  assert.equal(response.headers.get("x-correlation-id"), "handler-id");
  assert.equal(await response.text(), "data: [DONE]\n\n");
});
