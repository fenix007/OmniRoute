import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { waitForCooldownAwareRetry } from "../../src/sse/services/cooldownAwareRetry.ts";

function mockClock(t: TestContext) {
  let now = 1_000;
  const scheduled: Array<{
    callback: () => void;
    delay: number;
    token: ReturnType<typeof setTimeout>;
  }> = [];
  const cleared: Array<ReturnType<typeof setTimeout>> = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
    const token = { id: scheduled.length + 1 } as unknown as ReturnType<typeof setTimeout>;
    scheduled.push({ callback, delay, token });
    return token;
  });
  t.mock.method(globalThis, "clearTimeout", (token: ReturnType<typeof setTimeout>) => {
    cleared.push(token);
  });
  return { scheduled, cleared, advanceTo: (value: number) => (now = value) };
}

test("cooldown retry waits until the deadline when a timer fires one millisecond early", async (t) => {
  const clock = mockClock(t);
  const controller = new AbortController();
  const result = waitForCooldownAwareRetry(100, controller.signal);
  clock.advanceTo(1_099);
  clock.scheduled[0].callback();
  assert.equal(clock.scheduled.length, 2);
  assert.equal(clock.scheduled[1].delay, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  clock.advanceTo(1_100);
  clock.scheduled[1].callback();
  assert.equal(await result, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("abort clears the rescheduled cooldown timer and stale callbacks cannot restart it", async (t) => {
  const clock = mockClock(t);
  const controller = new AbortController();
  const result = waitForCooldownAwareRetry(100, controller.signal);
  clock.advanceTo(1_099);
  clock.scheduled[0].callback();
  assert.equal(clock.scheduled.length, 2);
  controller.abort();
  assert.equal(await result, false);
  assert.deepEqual(clock.cleared, [clock.scheduled[1].token]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  clock.scheduled[0].callback();
  clock.scheduled[1].callback();
  assert.equal(clock.scheduled.length, 2);
});

test("late cooldown timer completes once and releases its abort listener", async (t) => {
  const clock = mockClock(t);
  const controller = new AbortController();
  const result = waitForCooldownAwareRetry(100, controller.signal);
  clock.advanceTo(1_120);
  clock.scheduled[0].callback();
  assert.equal(await result, true);
  clock.scheduled[0].callback();
  assert.equal(clock.scheduled.length, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("concurrent cooldown waits retain independent deadlines and cancellation", async (t) => {
  const clock = mockClock(t);
  const first = new AbortController();
  const second = new AbortController();
  const firstResult = waitForCooldownAwareRetry(100, first.signal);
  const secondResult = waitForCooldownAwareRetry(200, second.signal);
  first.abort();
  assert.equal(await firstResult, false);
  assert.deepEqual(clock.cleared, [clock.scheduled[0].token]);
  assert.equal(getEventListeners(second.signal, "abort").length, 1);
  clock.advanceTo(1_200);
  clock.scheduled[1].callback();
  assert.equal(await secondResult, true);
  assert.equal(getEventListeners(second.signal, "abort").length, 0);
});
