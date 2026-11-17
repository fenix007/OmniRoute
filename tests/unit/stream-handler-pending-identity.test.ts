import test from "node:test";
import assert from "node:assert/strict";
import {
  createDisconnectAwareStream,
  createNoopAbortWritable,
  createStreamController,
} from "../../open-sse/utils/streamHandler.ts";
import { finalizeStreamRequestLog } from "../../open-sse/utils/streamFailureFinalization.ts";
import {
  finalizePendingScope,
  updatePendingScope,
} from "../../src/lib/usage/pendingRequestScope.ts";
import {
  clearPendingRequests,
  finalizePendingRequestById,
  getCompletedDetails,
  getPendingById,
  getPendingRequests,
  trackPendingRequest,
} from "../../src/lib/usage/usageHistory.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

const model = "gpt-6.1-sol";
const provider = "codex";
const connectionId = "shared-account";
const key = `${model} (${provider})`;
function startPair() {
  clearPendingRequests();
  const first = trackPendingRequest(model, provider, connectionId, true)!;
  const second = trackPendingRequest(model, provider, connectionId, true)!;
  return { first, second };
}
function assertOnlyPending(id: string) {
  assert.deepEqual([...getPendingById().keys()], [id]);
  assert.equal(getPendingRequests().byModel[key], 1);
  assert.equal(getPendingRequests().byAccount[connectionId][key], 1);
}

test("disconnect finalizes its own pending id and preserves an older sibling", () => {
  const { first, second } = startPair();
  const controller = createStreamController({
    model,
    provider,
    connectionId,
    pendingRequestId: second,
  });
  controller.handleDisconnect("client closed");
  assert.equal(controller.signal.aborted, true);
  assertOnlyPending(first);
  assert.equal(getCompletedDetails().get(second)?.status, 499);
  controller.handleDisconnect("again");
  controller.handleError(new Error("late provider failure"));
  assertOnlyPending(first);
  clearPendingRequests();
});

test("disconnect owner records terminal details before generic cleanup", () => {
  const { first, second } = startPair();
  const controller = createStreamController({
    model,
    provider,
    connectionId,
    pendingRequestId: second,
    onDisconnect() {
      assert.equal(getPendingById().has(second), true);
      return finalizePendingRequestById(second, {
        status: 499,
        errorCode: "client_disconnected",
        clientResponse: { stopped: true },
      });
    },
  });
  controller.handleDisconnect();
  assertOnlyPending(first);
  assert.deepEqual(getCompletedDetails().get(second)?.clientResponse, { stopped: true });
  clearPendingRequests();
});

test("terminal Responses event followed by client cancellation finalizes only its own id", async () => {
  const { first, second } = startPair();
  let disconnected = false;
  const stream = createDisconnectAwareStream(
    {
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: response.completed\ndata: {"type":"response.completed","response":{"output_text":"ok"}}\n\n'
            )
          );
        },
      }),
      writable: createNoopAbortWritable(),
    },
    createStreamController({
      model,
      provider,
      connectionId,
      pendingRequestId: second,
      clientResponseFormat: FORMATS.OPENAI_RESPONSES,
      onDisconnect() {
        disconnected = true;
      },
    })
  );
  const reader = stream.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /response.completed/);
  await reader.cancel("terminal received");
  assert.equal(disconnected, false);
  assertOnlyPending(first);
  assert.equal(getCompletedDetails().get(second)?.status, 200);
  clearPendingRequests();
});

test("an explicit completed id never falls back to another request in the same bucket", () => {
  const { first, second } = startPair();
  finalizePendingRequestById(second, { status: 499 });
  const scope = { id: second, model, provider, connectionId };
  updatePendingScope(scope, { stage: "late-update" });
  finalizePendingScope(scope, { status: 502 });
  finalizeStreamRequestLog({
    pendingRequestId: second,
    model,
    provider,
    connectionId,
    status: 502,
  });
  assertOnlyPending(first);
  assert.notEqual(getPendingById().get(first)?.stage, "late-update");
  assert.equal(getCompletedDetails().get(second)?.status, 499);
  clearPendingRequests();
});

test("legacy idless scope finalization remains supported", () => {
  const { second } = startPair();
  finalizePendingScope({ id: null, model, provider, connectionId }, { status: 200 });
  assertOnlyPending(second);
  clearPendingRequests();
});

test("controller error cleanup also works when only a pending id is supplied", () => {
  const { first, second } = startPair();
  const controller = createStreamController({ pendingRequestId: second });
  controller.handleError(Object.assign(new Error("provider failed"), { statusCode: 503 }));
  assertOnlyPending(first);
  assert.equal(getCompletedDetails().get(second)?.status, 503);
  clearPendingRequests();
});
