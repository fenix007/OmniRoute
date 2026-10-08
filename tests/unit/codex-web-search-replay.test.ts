import test from "node:test";
import assert from "node:assert/strict";

import {
  CodexExecutor,
  __setCodexWebSocketTransportForTesting,
} from "../../open-sse/executors/codex.ts";
import { ensureCodexCompactionWebSearchTool } from "../../open-sse/executors/codex/webSearchReplay.ts";

const searchCall = { type: "web_search_call", id: "ws_test", status: "completed" };
const message = {
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "Summarize" }],
};
const compactionMetadata = JSON.stringify({ request_kind: "compaction" });
const standardOptions = { isResponsesLite: false, isNativeCompact: false };
type WireBody = {
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  input?: Array<Record<string, unknown>>;
};

function compactionBody(): Record<string, unknown> {
  return {
    model: "gpt-6.1-sol",
    input: [searchCall, message],
    tools: [],
    client_metadata: { "x-codex-turn-metadata": compactionMetadata },
  };
}

test("Codex compaction declares cached web search without changing the original history", () => {
  const original = compactionBody();
  const result = ensureCodexCompactionWebSearchTool(original, standardOptions) as Record<
    string,
    unknown
  >;

  assert.deepEqual(result.tools, [{ type: "web_search", external_web_access: false }]);
  assert.equal(result.tool_choice, "none");
  assert.deepEqual(result.input, original.input);
  assert.deepEqual(original.tools, []);
  assert.equal(original.tool_choice, undefined);
});

test("Codex compaction repair respects existing declarations and request boundaries", () => {
  const original = compactionBody();
  const alreadyDeclared = { ...original, tools: [{ type: "web_search_preview" }] };
  assert.equal(
    ensureCodexCompactionWebSearchTool(alreadyDeclared, standardOptions),
    alreadyDeclared
  );
  assert.equal(
    ensureCodexCompactionWebSearchTool(original, {
      ...standardOptions,
      isNativeCompact: true,
    }),
    original
  );
  const normalTurn = {
    ...original,
    client_metadata: { "x-codex-turn-metadata": '{"request_kind":"turn"}' },
  };
  assert.equal(ensureCodexCompactionWebSearchTool(normalTurn, standardOptions), normalTurn);
  const withoutSearch = { ...original, input: [message] };
  assert.equal(ensureCodexCompactionWebSearchTool(withoutSearch, standardOptions), withoutSearch);
  const forcedTool = { ...original, tool_choice: "required" };
  assert.equal(ensureCodexCompactionWebSearchTool(forcedTool, standardOptions), forcedTool);
});

test("Responses Lite inserts additional_tools before the terminal compaction trigger", () => {
  const original = {
    model: "gpt-6.1-sol",
    input: [searchCall, { type: "compaction_trigger" }],
    tools: [],
  };
  const options = {
    isResponsesLite: true,
    isNativeCompact: false,
    turnMetadataHeader: compactionMetadata,
  };
  const result = ensureCodexCompactionWebSearchTool(original, options) as WireBody;

  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.input?.at(-2), {
    type: "additional_tools",
    role: "developer",
    tools: [{ type: "web_search", external_web_access: false }],
  });
  assert.deepEqual(result.input?.at(-1), { type: "compaction_trigger" });
  assert.equal(result.tool_choice, "none");
  assert.equal(ensureCodexCompactionWebSearchTool(result, options), result);
  assert.equal(original.input.length, 2);
});

test("Responses Lite extends an existing additional_tools item", () => {
  const original = {
    ...compactionBody(),
    input: [
      searchCall,
      { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "f" }] },
      { type: "compaction_trigger" },
    ],
  };
  const result = ensureCodexCompactionWebSearchTool(original, {
    ...standardOptions,
    isResponsesLite: true,
  }) as WireBody;

  assert.equal(result.input?.length, 3);
  assert.deepEqual(result.input?.[1].tools, [
    { type: "function", name: "f" },
    { type: "web_search", external_web_access: false },
  ]);
  assert.equal(result.tool_choice, "none");
});

test("Codex HTTP executor sends the repaired compaction body upstream", async () => {
  const originalFetch = globalThis.fetch;
  let sent: WireBody | null = null;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ object: "response", status: "completed" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const body = compactionBody();
    const result = await new CodexExecutor().execute({
      model: "gpt-6.1-sol",
      body,
      stream: true,
      credentials: { accessToken: "test-token" },
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(sent?.tools, [{ type: "web_search", external_web_access: false }]);
    assert.equal(sent?.tool_choice, "none");
    assert.equal(sent?.input?.[0]?.type, "web_search_call");
    assert.equal(sent?.input?.[0]?.status, "completed");
    assert.deepEqual(body.tools, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex HTTP Responses Lite keeps the web declaration in additional_tools", async () => {
  const originalFetch = globalThis.fetch;
  let sent: WireBody | null = null;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    const topLevelWeb = sent?.tools?.some((tool) => tool.type === "web_search");
    return new Response(JSON.stringify({ object: "response", status: "completed" }), {
      status: topLevelWeb ? 400 : 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await new CodexExecutor().execute({
      model: "gpt-6.1-sol",
      body: {
        model: "gpt-6.1-sol",
        input: [searchCall, { type: "compaction_trigger" }],
        tools: [],
      },
      stream: true,
      credentials: { accessToken: "test-token" },
      clientHeaders: {
        "x-codex-turn-metadata": compactionMetadata,
        "x-openai-internal-codex-responses-lite": "true",
      },
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(sent?.tools, []);
    assert.equal(sent?.tool_choice, "none");
    assert.deepEqual(sent?.input?.at(-2)?.tools, [
      { type: "web_search", external_web_access: false },
    ]);
    assert.equal(sent?.input?.at(-1)?.type, "compaction_trigger");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex WebSocket executor sends Responses Lite repair before compaction trigger", async () => {
  let sent: WireBody | null = null;
  __setCodexWebSocketTransportForTesting(async () => {
    const socket = {
      send(data: string) {
        sent = JSON.parse(data);
        queueMicrotask(() => {
          socket.onmessage?.({
            data: JSON.stringify({ type: "response.completed", response: { status: "completed" } }),
          });
        });
      },
      close() {},
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onerror: null,
      onclose: null,
    };
    return socket;
  });

  try {
    const result = await new CodexExecutor().execute({
      model: "gpt-6.1-sol",
      body: {
        model: "gpt-6.1-sol",
        input: [searchCall, { type: "compaction_trigger" }],
        tools: [],
      },
      stream: true,
      credentials: {
        accessToken: "test-token",
        providerSpecificData: { codexTransport: "websocket" },
      },
      clientHeaders: {
        "x-codex-turn-metadata": compactionMetadata,
        "x-openai-internal-codex-responses-lite": "true",
      },
    });
    await result.response.text();
    assert.deepEqual(sent?.tools, []);
    assert.equal(sent?.tool_choice, "none");
    assert.deepEqual(sent?.input?.at(-2)?.tools, [
      { type: "web_search", external_web_access: false },
    ]);
    assert.equal(sent?.input?.at(-1)?.type, "compaction_trigger");
  } finally {
    __setCodexWebSocketTransportForTesting(undefined);
  }
});
