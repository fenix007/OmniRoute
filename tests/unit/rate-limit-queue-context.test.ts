import "../_setup/isolateDataDir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { getEventListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import * as manager from "../../open-sse/services/rateLimitManager.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import {
  runWithAppliedProxyCapture,
  runWithProxyContext,
} from "../../open-sse/utils/proxyFetch.ts";

const store = new AsyncLocalStorage<string>();
let sequence = 0;

function connection() {
  const id = `queue-context-${++sequence}`;
  manager.enableRateLimitProtection(id);
  manager.refreshConnectionRateLimits(id, { maxConcurrent: 1, minTime: 0 });
  return id;
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), "queue reached the required state before the deadline");
}

async function readContext() {
  const start = store.getStore();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { start, after: store.getStore() };
}

function holdSlot(provider: string, id: string) {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const promise = store.run("A", () =>
    manager.withRateLimit(provider, id, null, async () => {
      entered.resolve();
      await gate.promise;
      return readContext();
    })
  );
  return { entered: entered.promise, release: () => gate.resolve(), promise };
}

test.afterEach(async () => manager.__resetRateLimitManagerForTests());
test.after(() => {
  store.disable();
  resetDbInstance();
});

for (const provider of ["codex", "kiro", "gemini"]) {
  for (const signalMode of [false, true]) {
    test(
      `${provider}: queued caller and no-context caller remain isolated (signal=${signalMode})`,
      {
        timeout: 10000,
      },
      async () => {
        const id = connection();
        const held = holdSlot(provider, id);
        const signals = [new AbortController().signal, new AbortController().signal];
        const pending: Promise<unknown>[] = [held.promise];
        try {
          await held.entered;
          pending.push(
            store.run("B", () =>
              manager.withRateLimit(provider, id, null, readContext, signalMode ? signals[0] : null)
            )
          );
          pending.push(
            manager.withRateLimit(provider, id, null, readContext, signalMode ? signals[1] : null)
          );
          await waitUntil(() => manager.getRateLimitStatus(provider, id).queued === 2);
          held.release();
          assert.deepEqual(await Promise.all(pending), [
            { start: "A", after: "A" },
            { start: "B", after: "B" },
            { start: undefined, after: undefined },
          ]);
          assert.equal(store.getStore(), undefined);
          for (const signal of signals) assert.equal(getEventListeners(signal, "abort").length, 0);
        } finally {
          held.release();
          await Promise.allSettled(pending);
        }
      }
    );
  }
}

test("disabled connection keeps direct-call arguments and caller context", async () => {
  const result = await store.run("direct", () =>
    manager.withRateLimit("codex", "disabled-context", null, async (...args: unknown[]) => {
      assert.deepEqual(args, []);
      return readContext();
    })
  );
  assert.deepEqual(result, { start: "direct", after: "direct" });
});

test("queued rejection preserves its error and leaves the next caller isolated", async () => {
  const id = connection();
  const held = holdSlot("codex", id);
  const failure = new Error("synthetic provider failure");
  const signal = new AbortController().signal;
  const pending: Promise<unknown>[] = [held.promise];
  try {
    await held.entered;
    const rejected = store.run("B", () =>
      manager.withRateLimit(
        "codex",
        id,
        null,
        async () => {
          assert.deepEqual(await readContext(), { start: "B", after: "B" });
          throw failure;
        },
        signal
      )
    );
    const assertion = assert.rejects(rejected, (error) => error === failure);
    pending.push(assertion);
    const next = store.run("C", () => manager.withRateLimit("codex", id, null, readContext));
    pending.push(next);
    await waitUntil(() => manager.getRateLimitStatus("codex", id).queued === 2);
    held.release();
    await assertion;
    assert.deepEqual(await next, { start: "C", after: "C" });
    assert.equal(getEventListeners(signal, "abort").length, 0);
  } finally {
    held.release();
    await Promise.allSettled(pending);
  }
});

test("queued abort preserves rejection and context when the old queue later dispatches", async () => {
  const id = connection();
  const held = holdSlot("kiro", id);
  const controller = new AbortController();
  const reason = new Error("synthetic disconnect");
  const dispatched = Promise.withResolvers<void>();
  let observed: string | undefined;
  let providerCalls = 0;
  const pending: Promise<unknown>[] = [held.promise];
  try {
    await held.entered;
    // The frozen queue does not remove cancelled jobs. Preserve that contract:
    // the executor checks its own signal before any provider request.
    const cancelled = store.run("B", () =>
      manager.withRateLimit(
        "kiro",
        id,
        null,
        async () => {
          observed = store.getStore();
          dispatched.resolve();
          controller.signal.throwIfAborted();
          providerCalls++;
        },
        controller.signal
      )
    );
    const assertion = assert.rejects(cancelled, (error) => error === reason);
    pending.push(assertion);
    await waitUntil(() => manager.getRateLimitStatus("kiro", id).queued === 1);
    controller.abort(reason);
    await assertion;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    held.release();
    await dispatched.promise;
    await waitUntil(() => manager.getRateLimitStatus("kiro", id).running === 0);
    assert.equal(observed, "B");
    assert.equal(providerCalls, 0);
  } finally {
    held.release();
    await Promise.allSettled(pending);
  }
});

test("already-aborted callers never enter the enabled limiter", async () => {
  const id = connection();
  const controller = new AbortController();
  const reason = new Error("cancel before scheduling");
  controller.abort(reason);
  let calls = 0;
  await assert.rejects(
    manager.withRateLimit(
      "kiro",
      id,
      null,
      async () => {
        calls++;
      },
      controller.signal
    ),
    (error) => error === reason
  );
  assert.equal(calls, 0);
  assert.equal(manager.getRateLimitStatus("kiro", id).active, false);
});

test("queued proxy capture writes only to its own request sink", async () => {
  const id = connection();
  const sinks: Array<{ proxy: unknown }> = [{ proxy: null }, { proxy: null }];
  // Relay context avoids DNS/TCP health probes; no fetch is performed.
  const proxies = [
    { type: "vercel", host: "first.invalid", port: 443 },
    { type: "vercel", host: "second.invalid", port: 443 },
  ];
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const pending: Promise<unknown>[] = [];
  try {
    pending.push(
      runWithAppliedProxyCapture(sinks[0], () =>
        manager.withRateLimit("gemini", id, null, async () => {
          entered.resolve();
          await gate.promise;
          return runWithProxyContext(proxies[0], async () => "first");
        })
      )
    );
    await entered.promise;
    pending.push(
      runWithAppliedProxyCapture(sinks[1], () =>
        manager.withRateLimit("gemini", id, null, () =>
          runWithProxyContext(proxies[1], async () => "second")
        )
      )
    );
    await waitUntil(() => manager.getRateLimitStatus("gemini", id).queued === 1);
    gate.resolve();
    assert.deepEqual(await Promise.all(pending), ["first", "second"]);
    assert.equal(sinks[0].proxy, proxies[0]);
    assert.equal(sinks[1].proxy, proxies[1]);
  } finally {
    gate.resolve();
    await Promise.allSettled(pending);
  }
});
