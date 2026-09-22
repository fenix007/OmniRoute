import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTargetTimeoutRunner } from "../../open-sse/services/combo/targetTimeoutRunner.ts";
import type { SingleModelTarget } from "../../open-sse/services/combo/types.ts";

const noopLog = { warn() {}, info() {}, error() {}, debug() {} };

function targetAbortSignal(target?: SingleModelTarget): AbortSignal | undefined {
  return target?.modelAbortSignal ?? undefined;
}

test("timeout<=0: passthrough direto (sem timer)", async () => {
  let called = false;
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async () => {
      called = true;
      return new Response("ok");
    },
    comboTargetTimeoutMs: 0,
    log: noopLog,
  });
  const res = await runner({}, "m");
  assert.equal(called, true);
  assert.equal(await res.text(), "ok");
});

test("timeout<=0: erro do upstream vira errorResponse 502", async () => {
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async () => {
      throw new Error("boom");
    },
    comboTargetTimeoutMs: 0,
    log: noopLog,
  });
  const res = await runner({}, "m");
  assert.equal(res.status, 502);
});

test("excede o limite: aborta e retorna 524 timed out", async () => {
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: (_b, _m, target) =>
      new Promise<Response>((resolve) => {
        const signal = targetAbortSignal(target);
        signal?.addEventListener("abort", () => resolve(new Response(null, { status: 599 })));
      }),
    comboTargetTimeoutMs: 20,
    log: noopLog,
  });
  const res = await runner({}, "slow-model");
  assert.equal(res.status, 524);
  const body = await res.json();
  assert.match(JSON.stringify(body), /timed out/i);
});

test("sucesso rápido vence a corrida do timeout", async () => {
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: async () => new Response("fast", { status: 200 }),
    comboTargetTimeoutMs: 1000,
    log: noopLog,
  });
  const res = await runner({}, "m");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "fast");
});

test("external parent abort preserves its reason on the child", async () => {
  const parent = new AbortController();
  const reason = new Error("request_signal_aborted");
  parent.abort(reason);
  let childReason: unknown = null;
  const runner = buildTargetTimeoutRunner({
    handleSingleModel: (_b, _m, target) => {
      childReason = targetAbortSignal(target)?.reason;
      return Promise.resolve(new Response("ok"));
    },
    comboTargetTimeoutMs: 1000,
    log: noopLog,
  });
  await runner({}, "m", { modelAbortSignal: parent.signal });
  assert.equal(childReason, reason);
});

function stallUntilAborted(target?: SingleModelTarget): Promise<Response> {
  return new Promise((resolve) => {
    target?.modelAbortSignal?.addEventListener(
      "abort",
      () => resolve(new Response(null, { status: 599 })),
      { once: true }
    );
  });
}

test("Codex timeout retries once excluding every selected account and preserving routing constraints", async () => {
  const seen: SingleModelTarget[] = [];
  const runner = buildTargetTimeoutRunner({
    retryCodexAccountOnTimeout: true,
    comboTargetTimeoutMs: 10,
    log: noopLog,
    handleSingleModel: async (body, _model, target) => {
      seen.push(target!);
      if (seen.length === 1) {
        target?.onConnectionSelected?.("first");
        target?.onConnectionSelected?.("rotated-before-timeout");
        body.changed = true;
        return stallUntilAborted(target);
      }
      assert.equal(body.changed, undefined, "retry receives the original body");
      target?.onConnectionSelected?.("healthy");
      return new Response("recovered");
    },
  });
  const result = await runner({}, "codex/gpt-5.6-sol-medium", {
    provider: "codex",
    allowedConnectionIds: ["first", "healthy"],
    excludeConnectionIds: ["previous"],
  } as SingleModelTarget);
  assert.equal(await result.text(), "recovered");
  assert.deepEqual(seen[1].excludeConnectionIds, ["previous", "first", "rotated-before-timeout"]);
  assert.deepEqual("allowedConnectionIds" in seen[1] ? seen[1].allowedConnectionIds : undefined, [
    "first",
    "healthy",
  ]);
  assert.equal(seen[0].modelAbortSignal?.aborted, true);
  assert.equal(seen[1].modelAbortSignal?.aborted, false);
});

test("Codex account retry is bounded across outer combo retries", async () => {
  let calls = 0;
  const runner = buildTargetTimeoutRunner({
    retryCodexAccountOnTimeout: true,
    comboTargetTimeoutMs: 10,
    log: noopLog,
    handleSingleModel: async (_body, _model, target) => {
      target?.onConnectionSelected?.(`account-${++calls}`);
      return stallUntilAborted(target);
    },
  });
  assert.equal((await runner({}, "cx/gpt-5.6-sol")).status, 524);
  assert.equal(calls, 2);
  assert.equal((await runner({}, "cx/gpt-5.6-sol")).status, 524);
  assert.equal(calls, 3, "no second account-retry budget on an outer retry");
});

for (const scenario of [
  "disabled",
  "different-provider",
  "pinned-account",
  "upstream-524",
  "no-selected-account",
]) {
  test(`does not rotate for ${scenario}`, async () => {
    let calls = 0;
    const runner = buildTargetTimeoutRunner({
      retryCodexAccountOnTimeout: scenario !== "disabled",
      comboTargetTimeoutMs: 10,
      log: noopLog,
      handleSingleModel: async (_body, _model, target) => {
        calls++;
        if (scenario !== "no-selected-account") target?.onConnectionSelected?.("first");
        return scenario === "upstream-524"
          ? new Response("upstream timeout", { status: 524 })
          : stallUntilAborted(target);
      },
    });
    const target =
      scenario === "pinned-account"
        ? ({ provider: "codex", connectionId: "first" } as SingleModelTarget)
        : undefined;
    const result = await runner(
      {},
      scenario === "different-provider" ? "openai/gpt-5.6-sol" : "codex/gpt-5.6-sol",
      target
    );
    assert.equal(result.status, 524);
    assert.equal(calls, 1);
  });
}

test("client cancellation at the deadline prevents the account retry", async () => {
  const parent = new AbortController();
  let calls = 0;
  const runner = buildTargetTimeoutRunner({
    retryCodexAccountOnTimeout: true,
    comboTargetTimeoutMs: 10,
    signal: parent.signal,
    log: noopLog,
    handleSingleModel: async (_body, _model, target) => {
      calls++;
      target?.onConnectionSelected?.("first");
      target?.modelAbortSignal?.addEventListener("abort", () => parent.abort("client gone"));
      return stallUntilAborted(target);
    },
  });
  await runner({}, "codex/gpt-5.6-sol");
  assert.equal(calls, 1);
});

test("no eligible alternate preserves a readable timeout response", async () => {
  let calls = 0;
  const runner = buildTargetTimeoutRunner({
    retryCodexAccountOnTimeout: true,
    comboTargetTimeoutMs: 10,
    log: noopLog,
    handleSingleModel: async (_body, _model, target) => {
      if (++calls === 1) {
        target?.onConnectionSelected?.("first");
        return stallUntilAborted(target);
      }
      return new Response("no eligible accounts", { status: 503 });
    },
  });
  const result = await runner({}, "codex/gpt-5.6-sol");
  assert.equal(result.status, 524);
  assert.match(await result.text(), /timed out/);
});

test("a committed stream is returned once without a timeout retry", async () => {
  let calls = 0;
  const runner = buildTargetTimeoutRunner({
    retryCodexAccountOnTimeout: true,
    comboTargetTimeoutMs: 10,
    log: noopLog,
    handleSingleModel: async (_body, _model, target) => {
      calls++;
      target?.onConnectionSelected?.("first");
      return new Response("data: partial output\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  assert.match(
    await (await runner({ stream: true }, "codex/gpt-5.6-sol")).text(),
    /partial output/
  );
  assert.equal(calls, 1);
});
