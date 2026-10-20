import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-attempt-latency-"));
process.env.DATA_DIR = testDataDir;

const latency = await import("../../open-sse/services/codexAttemptLatency.ts");
const health = await import("../../open-sse/services/codexConnectionHealth.ts");
const prl = await import("../../open-sse/utils/providerRequestLogging.ts");
const { CodexExecutor } = await import("../../open-sse/executors/codex.ts");

test.after(async () => {
  const { resetDbInstance } = await import("../../src/lib/db/core.ts");
  resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  health.resetCodexConnectionHealth();
});

function sse(type: string, extra = ""): string {
  return `event: ${type}\ndata: {"type":"${type}"${extra}}\n\n`;
}

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

test("event classes separate lifecycle, useful output, text and terminal events", () => {
  assert.equal(latency.classifyCodexEventType("response.created"), "lifecycle");
  assert.equal(latency.classifyCodexEventType("codex.rate_limits"), "lifecycle");
  assert.equal(latency.classifyCodexEventType("response.output_item.added"), "useful");
  assert.equal(latency.classifyCodexEventType("response.reasoning_summary_text.delta"), "useful");
  assert.equal(latency.classifyCodexEventType("response.output_text.delta"), "text");
  assert.equal(latency.classifyCodexEventType("response.function_call_arguments.delta"), "text");
  assert.equal(latency.classifyCodexEventType("response.completed"), "completed");
  assert.equal(latency.classifyCodexEventType("response.failed"), "failed");
  assert.equal(latency.classifyCodexEventType("error"), "failed");
  assert.equal(latency.classifyCodexEventType("ping"), null);
  assert.equal(
    latency.readCodexEventType('data: {"type":"response.created","x":1}'),
    "response.created"
  );
});

test("handshake now, useful output at 6 s and completion at 20 s are kept apart", () => {
  const time = clock();
  const samples: unknown[] = [];
  const observer = new latency.CodexAttemptObserver({
    connectionId: "acc-1",
    transport: "http",
    now: time.now,
    sink: (sample) => samples.push(sample),
  });

  observer.observeEventType("response.created");
  time.advance(6_000);
  observer.observeEventType("response.output_item.added");
  time.advance(2_000);
  observer.observeEventType("response.output_text.delta");
  time.advance(12_000);
  observer.observeEventType("response.completed");
  observer.observeEventType("response.output_text.delta");

  const snapshot = observer.snapshot();
  assert.equal(snapshot.lifecycleMs, 0);
  assert.equal(snapshot.firstUsefulMs, 6_000);
  assert.equal(snapshot.firstUsefulType, "response.output_item.added");
  assert.equal(snapshot.firstTextMs, 8_000);
  assert.equal(snapshot.completedMs, 20_000);
  assert.equal(snapshot.outcome, "completed");
  // Published at the first useful event and again at completion, never after.
  assert.equal(samples.length, 2);
});

test("a stream that only completes has no first useful output", () => {
  const time = clock();
  const observer = new latency.CodexAttemptObserver({ transport: "ws", now: time.now });
  observer.observeEventType("response.created");
  time.advance(3_000);
  observer.observeEventType("response.completed");
  assert.equal(observer.snapshot().firstUsefulMs, null);
  assert.equal(observer.snapshot().outcome, "completed");
});

test("first useful output feeds account health exactly once per attempt", () => {
  for (const [id, ms] of [
    ["slow", 8_000],
    ["fast", 3_500],
  ] as const) {
    for (let i = 0; i < 5; i++) {
      const time = clock(Date.now() - 60_000 + i * 1_000);
      const observer = new latency.CodexAttemptObserver({
        connectionId: id,
        transport: "http",
        now: time.now,
      });
      time.advance(ms);
      observer.observeEventType("response.output_item.added");
      observer.observeEventType("response.output_text.delta");
      observer.observeEventType("response.reasoning_summary_text.delta");
    }
  }
  const factor = health.codexConnectionHealthFactor("slow", ["slow", "fast"], Date.now());
  assert.ok(Math.abs(factor - 3_500 / 8_000) < 1e-9, `factor=${factor}`);
});

test("the scanner reassembles split frames and bounds oversized lines", () => {
  const time = clock();
  const observer = new latency.CodexAttemptObserver({ transport: "http", now: time.now });
  const scanner = new latency.CodexSseEventScanner(observer);
  const created = sse("response.created");
  const huge = sse("response.output_item.done", `,"text":"${"x".repeat(200_000)}"`);
  const text = sse("response.output_text.delta", ',"delta":"hi"');
  const all = new TextEncoder().encode(created + huge + text);

  for (let i = 0; i < all.length; i += 7) scanner.push(all.slice(i, i + 7));

  const snapshot = observer.snapshot();
  assert.equal(snapshot.lifecycleMs, 0);
  assert.equal(snapshot.firstUsefulType, "response.output_item.done");
  assert.equal(snapshot.firstTextMs, 0);
});

test("replaying peeked bytes through the stream does not move first moments", async () => {
  const time = clock();
  const observer = new latency.CodexAttemptObserver({ transport: "http", now: time.now });
  const prefix = sse("response.created") + sse("response.output_item.added");
  const peekScanner = new latency.CodexSseEventScanner(observer);
  peekScanner.push(prefix);

  time.advance(9_000);
  const body = new Response(
    prefix + sse("response.output_text.delta") + sse("response.completed"),
    {
      headers: { "content-type": "text/event-stream" },
    }
  );
  const observed = latency.observeCodexSseResponse(body, observer);
  assert.equal(
    await observed.text(),
    prefix + sse("response.output_text.delta") + sse("response.completed")
  );

  const snapshot = observer.snapshot();
  assert.equal(snapshot.firstUsefulMs, 0);
  assert.equal(snapshot.firstTextMs, 9_000);
  assert.equal(snapshot.outcome, "completed");
});

test("cancelling the client stream ends the attempt as aborted", async () => {
  const observer = new latency.CodexAttemptObserver({ transport: "http" });
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse("response.created")));
    },
  });
  const observed = latency.observeCodexSseResponse(
    new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
    observer
  );
  const reader = observed.body!.getReader();
  await reader.read();
  await reader.cancel("client left");
  assert.equal(observer.snapshot().outcome, "aborted");
});

test("Codex HTTP attempts report their latency to the request capture", async () => {
  const executor = new CodexExecutor();
  const originalFetch = globalThis.fetch;
  const capture = prl.createPreparedRequestLogger(
    { logTargetRequest: () => {} },
    {} as Parameters<typeof prl.createPreparedRequestLogger>[1]
  );

  globalThis.fetch = async () =>
    new Response(
      sse("response.created") +
        sse("response.output_text.delta", ',"delta":"OK"') +
        sse("response.completed"),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );

  try {
    const result = await prl.runWithCapture(capture, () =>
      executor.execute({
        model: "gpt-5.5",
        body: { model: "gpt-5.5", input: [{ role: "user", content: "hello" }] },
        stream: true,
        credentials: { accessToken: "codex-token", connectionId: "conn-latency" },
      })
    );
    await (result as { response: Response }).response.text();

    const sample = capture.latestAttemptLatency?.();
    assert.ok(sample, "attempt latency must reach the request");
    assert.equal(sample.connectionId, "conn-latency");
    assert.equal(sample.transport, "http");
    assert.equal(sample.firstUsefulType, "response.output_text.delta");
    assert.equal(sample.outcome, "completed");
    assert.ok(sample.firstUsefulMs !== null && sample.firstUsefulMs >= 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request class reads the effort and prompt size actually sent upstream", () => {
  const small = latency.describeCodexRequestClass({
    model: "gpt-6.1-sol",
    reasoning: { effort: "high", summary: "auto" },
    instructions: "Be terse.",
    input: [{ role: "user", content: "hi" }],
  });
  assert.equal(small.model, "gpt-6.1-sol");
  assert.equal(small.effort, "high");
  assert.equal(small.inputBucket, "<8k");

  const large = latency.describeCodexRequestClass({ input: "x".repeat(400_000) }, "gpt-6-luna");
  assert.equal(large.model, "gpt-6-luna");
  assert.equal(large.effort, null);
  assert.equal(large.inputBucket, ">50k");
});

test("slow start is a separate censored mark and never replaces TTFT", async () => {
  const observer = new latency.CodexAttemptObserver({
    connectionId: "slow-acc",
    transport: "http",
  });
  observer.armSlowStart(20);
  observer.observeEventType("response.created");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(observer.snapshot().slowStartMs !== null, "threshold crossed without output");
  assert.equal(observer.snapshot().firstUsefulMs, null);
  assert.equal(health.codexSlowStartCount("slow-acc"), 1);

  observer.observeEventType("response.output_text.delta");
  assert.ok(observer.snapshot().firstUsefulMs !== null);
  // The censored mark is not a TTFT sample: one slow start, no factor change.
  assert.equal(health.codexConnectionHealthFactor("slow-acc", ["slow-acc", "other"]), 1);
});

test("useful output or a finished attempt cancels the slow-start mark", async () => {
  const fast = new latency.CodexAttemptObserver({ connectionId: "fast-acc", transport: "http" });
  fast.armSlowStart(20);
  fast.observeEventType("response.output_item.added");
  const failed = new latency.CodexAttemptObserver({ connectionId: "err-acc", transport: "http" });
  failed.armSlowStart(20);
  failed.finish("failed");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fast.snapshot().slowStartMs, null);
  assert.equal(failed.snapshot().slowStartMs, null);
  assert.equal(health.codexSlowStartCount("fast-acc"), 0);
  assert.equal(health.codexSlowStartCount("err-acc"), 0);
});

test("slow-start threshold comes from CODEX_SLOW_START_MS", () => {
  assert.equal(latency.codexSlowStartThresholdMs({}), latency.DEFAULT_CODEX_SLOW_START_MS);
  assert.equal(latency.codexSlowStartThresholdMs({ CODEX_SLOW_START_MS: "0" }), 0);
  assert.equal(latency.codexSlowStartThresholdMs({ CODEX_SLOW_START_MS: "12000" }), 12_000);
  assert.equal(
    latency.codexSlowStartThresholdMs({ CODEX_SLOW_START_MS: "soon" }),
    latency.DEFAULT_CODEX_SLOW_START_MS
  );
});

test("the latency log line names class, routing and every moment", () => {
  const time = clock();
  const observer = new latency.CodexAttemptObserver({
    connectionId: "0123456789abcdef",
    transport: "ws",
    now: time.now,
  });
  observer.setRequestClass(
    latency.describeCodexRequestClass({ model: "gpt-6.1-sol", reasoning: { effort: "low" } })
  );
  observer.observeEventType("response.created");
  time.advance(1_200);
  observer.observeEventType("response.output_text.delta");
  time.advance(800);
  observer.observeEventType("response.completed");

  const line = latency.formatCodexAttemptLatency(observer.snapshot(), "affinity_reused");
  assert.equal(
    line,
    "conn=01234567 transport=ws model=gpt-6.1-sol effort=low input=<8k routing=affinity_reused " +
      "lifecycle=0ms useful=1200ms(response.output_text.delta) text=1200ms completed=2000ms outcome=completed"
  );
});
