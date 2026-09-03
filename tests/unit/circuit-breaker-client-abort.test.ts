import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-client-abort-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { CircuitBreaker, isLocalStreamLifecycleError, resetAllCircuitBreakers } =
  await import("../../src/shared/utils/circuitBreaker.ts");
const { shouldRecordProviderBreakerFailure, shouldSkipConnDisable } =
  await import("../../open-sse/services/combo/comboPredicates.ts");
const { classifyLocalAbortFailure, shouldTripProviderBreakerForResult } =
  await import("../../src/sse/handlers/chatPredicates.ts");
const dbCore = await import("../../src/lib/db/core.ts");

const uniqueName = (suffix: string) =>
  `cb-client-abort-${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.after(() => {
  resetAllCircuitBreakers();
  dbCore.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

test("known client-abort shapes are local lifecycle errors", () => {
  const abortError = new Error("nonstandard abort message");
  abortError.name = "AbortError";
  assert.equal(isLocalStreamLifecycleError(abortError), true);

  assert.equal(isLocalStreamLifecycleError("request_signal_aborted"), false);
  assert.equal(isLocalStreamLifecycleError(new Error("Client disconnected: model switch")), false);
  assert.equal(isLocalStreamLifecycleError({ message: "This operation was aborted" }), false);
  assert.equal(isLocalStreamLifecycleError(new Error("502 Bad Gateway")), false);
  assert.equal(isLocalStreamLifecycleError(new Error("429 rate limited")), false);
  assert.deepEqual(classifyLocalAbortFailure("request_signal_aborted", true), {
    status: 499,
    message: "Request aborted",
  });
  assert.deepEqual(classifyLocalAbortFailure(new Error("combo-per-model-timeout"), true), {
    status: 499,
    message: "Request aborted",
  });
  assert.deepEqual(classifyLocalAbortFailure(new Error("hedge-cancelled"), true), {
    status: 499,
    message: "Request aborted",
  });
  assert.equal(classifyLocalAbortFailure(new Error("combo-per-model-timeout"), false), null);
  assert.equal(classifyLocalAbortFailure("request_signal_aborted", false), null);
  assert.equal(classifyLocalAbortFailure(new Error("502 Bad Gateway")), null);
});

test("repeated client aborts do not advance a circuit breaker", async () => {
  const breaker = new CircuitBreaker(uniqueName("repeated"), {
    failureThreshold: 2,
    isFailure: (error) => !isLocalStreamLifecycleError(error),
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(
      breaker.execute(async () => {
        const error = new Error("provider request cancelled");
        error.name = "AbortError";
        throw error;
      }),
      /provider request cancelled/
    );
  }

  assert.equal(breaker.state, "CLOSED");
  assert.equal(breaker.failureCount, 0);
  breaker.reset();
});

test("manual single-model and combo breaker paths exclude normalized 499 but count upstream text", () => {
  const abort = { status: 499, error: "request_signal_aborted" } as const;
  assert.equal(shouldSkipConnDisable(abort, false, false, "codex"), true);
  assert.equal(shouldTripProviderBreakerForResult(abort, false, false), false);
  assert.equal(
    shouldRecordProviderBreakerFailure({
      isStreamReadinessFailure: false,
      status: abort.status,
      sameProviderNext: false,
    }),
    false
  );

  const upstream = { status: 502, error: "upstream bad gateway" } as const;
  assert.equal(shouldSkipConnDisable(upstream, false, false, "codex"), false);
  assert.equal(shouldTripProviderBreakerForResult(upstream, false, false), true);
  assert.equal(
    shouldRecordProviderBreakerFailure({
      isStreamReadinessFailure: false,
      status: upstream.status,
      sameProviderNext: false,
    }),
    true
  );

  const spoofedAbortText = { status: 502, error: "The operation was aborted" } as const;
  assert.equal(shouldSkipConnDisable(spoofedAbortText, false, false, "codex"), false);
  assert.equal(shouldTripProviderBreakerForResult(spoofedAbortText, false, false), true);
  assert.equal(
    shouldRecordProviderBreakerFailure({
      isStreamReadinessFailure: false,
      status: spoofedAbortText.status,
      sameProviderNext: false,
    }),
    true
  );
});
