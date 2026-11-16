type JsonRecord = Record<string, unknown>;

type WebSearchReplayOptions = {
  isResponsesLite: boolean;
  isNativeCompact: boolean;
  turnMetadataHeader?: string | null;
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function hasWebSearchTool(tools: unknown): boolean {
  return (
    Array.isArray(tools) &&
    tools.some((tool) => {
      const type = asRecord(tool)?.type;
      return typeof type === "string" && type.startsWith("web_search");
    })
  );
}

function isCompactionMetadata(value: unknown): boolean {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  return asRecord(value)?.request_kind === "compaction";
}

/**
 * Codex replays hosted web_search_call items during context compaction but sends
 * tools: []. The Codex upstream now rejects that history with an in-band
 * "response protection is unavailable" error. Declare the historical tool
 * without allowing a new tool call during the summary request.
 */
export function ensureCodexCompactionWebSearchTool(
  bodyInput: unknown,
  options: WebSearchReplayOptions
): unknown {
  const body = asRecord(bodyInput);
  if (options.isNativeCompact || !body || !Array.isArray(body.input)) return bodyInput;

  const clientMetadata = asRecord(body.client_metadata);
  if (
    !isCompactionMetadata(clientMetadata?.["x-codex-turn-metadata"]) &&
    !isCompactionMetadata(options.turnMetadataHeader)
  ) {
    return bodyInput;
  }
  if (!body.input.some((item) => asRecord(item)?.type === "web_search_call")) return bodyInput;
  if (body.tools !== undefined && !Array.isArray(body.tools)) return bodyInput;
  if (hasForcedToolChoice(body)) return bodyInput;

  if (hasDeclaredWebSearch(body)) return bodyInput;

  const copy = { ...body };
  const webSearch = { type: "web_search", external_web_access: false };
  if (options.isResponsesLite) {
    const input = addLiteWebSearch(body.input, webSearch);
    if (!input) return bodyInput;
    copy.input = input;
  } else {
    copy.tools = [...((copy.tools as unknown[] | undefined) ?? []), webSearch];
  }
  copy.tool_choice = "none";
  return copy;
}

function hasDeclaredWebSearch(body: JsonRecord): boolean {
  const additionalTools = (body.input as unknown[]).filter(
    (item) => asRecord(item)?.type === "additional_tools"
  );
  return (
    hasWebSearchTool(body.tools) ||
    additionalTools.some((item) => hasWebSearchTool(asRecord(item)?.tools))
  );
}

function addLiteWebSearch(original: unknown[], webSearch: JsonRecord): unknown[] | null {
  const input = [...original];
  const existingIndex = input.findIndex((item) => asRecord(item)?.type === "additional_tools");
  if (existingIndex >= 0) {
    const existing = asRecord(input[existingIndex]);
    const tools = existing?.tools;
    if (!Array.isArray(tools)) return null;
    input[existingIndex] = { ...existing, tools: [...tools, webSearch] };
  } else {
    const insertAt =
      asRecord(input[input.length - 1])?.type === "compaction_trigger"
        ? input.length - 1
        : input.length;
    input.splice(insertAt, 0, { type: "additional_tools", role: "developer", tools: [webSearch] });
  }
  return input;
}

function hasForcedToolChoice(body: JsonRecord): boolean {
  return (
    body.tool_choice !== undefined && body.tool_choice !== "auto" && body.tool_choice !== "none"
  );
}
