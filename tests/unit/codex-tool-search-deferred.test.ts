import test from "node:test";
import assert from "node:assert/strict";

import { CodexExecutor, normalizeCodexTools } from "../../open-sse/executors/codex.ts";

// Codex CLI 0.159.x sends the `tool_search` hosted tool together with MCP/dynamic
// function tools marked `defer_loading: true`. The Codex backend rejects
// `tool_search` unless at least one deferred tool survives:
//   400 "Invalid Value: 'tools.tool_search'. tools.tool_search requires at least
//   one deferred tool."
// normalizeCodexTools used to rebuild flat function tools from a whitelist and
// silently dropped `defer_loading`, so every Codex turn with MCP tools failed on
// the codex target and the combo fell through to unrelated providers.

const SHELL = {
  type: "function",
  name: "shell_command",
  description: "run",
  strict: false,
  parameters: { type: "object", properties: { command: { type: "string" } } },
};
const DEFERRED = {
  type: "function",
  name: "mcp__github__search",
  description: "search github",
  strict: false,
  defer_loading: true,
  parameters: { type: "object", properties: {} },
};

function codexBody() {
  return {
    model: "gpt-6-astra",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
    tools: [structuredClone(SHELL), { type: "tool_search" }, structuredClone(DEFERRED)],
    tool_choice: "auto",
  };
}

test("normalizeCodexTools keeps defer_loading on flat function tools", () => {
  const body = codexBody() as Record<string, unknown>;
  normalizeCodexTools(body);
  const tools = body.tools as Record<string, unknown>[];
  assert.deepEqual(
    tools.map((t) => t.type),
    ["function", "tool_search", "function"]
  );
  assert.equal(tools[2].defer_loading, true);
  assert.equal("defer_loading" in tools[0], false, "non-deferred tools stay unmarked");
});

test("normalizeCodexTools keeps defer_loading when flattening a chat-shaped function", () => {
  const body: Record<string, unknown> = {
    tools: [
      { type: "tool_search" },
      {
        type: "function",
        function: { name: "lookup", parameters: { type: "object" }, defer_loading: true },
      },
    ],
  };
  normalizeCodexTools(body);
  const tools = body.tools as Record<string, unknown>[];
  assert.equal(tools[1].name, "lookup");
  assert.equal(tools[1].defer_loading, true);
  assert.equal(tools[1].function, undefined);
});

for (const native of [true, false]) {
  test(`CodexExecutor.transformRequest preserves deferred tools for tool_search (native=${native})`, () => {
    const body = { ...codexBody(), _nativeCodexPassthrough: native };
    const result = new CodexExecutor().transformRequest("gpt-6-astra", body, true, {
      requestEndpointPath: "/responses",
    }) as Record<string, unknown>;
    const tools = result.tools as Record<string, unknown>[];
    assert.ok(tools.some((t) => t.type === "tool_search"));
    const deferred = tools.find((t) => t.name === "mcp__github__search");
    assert.equal(deferred?.defer_loading, true);
  });
}
