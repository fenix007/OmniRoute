// Codex Responses-API tool normalization (hosted-tool passthrough + free-plan gating).
// Self-contained helpers for declarations and tool choices (console.debug only).

// Responses-API hosted tool types that OpenAI/Codex executes server-side.
// These arrive shaped as `{ type, ...params }` with no `function` object and no `name` —
// e.g. Codex CLI injects `{ type: "image_generation", output_format: "png" }` or
// `{ type: "namespace", name: "mcp__atlassian__", tools: [...] }` for MCP tool groups.
// Keep them through `normalizeCodexTools` so upstream can execute them.
export const CODEX_HOSTED_TOOL_TYPES: ReadonlySet<string> = new Set([
  "tool_search",
  "image_generation",
  "web_search",
  "web_search_preview",
  "file_search",
  "computer",
  "computer_use_preview",
  "code_interpreter",
  "mcp",
]);

// #2980: a free-plan Codex account (workspacePlanType === "free", from the OAuth
// id_token) cannot run the server-side `image_generation` hosted tool. The Codex
// CLI injects it into every Responses request regardless of plan, so it must be
// dropped for free-plan accounts (mirrors CLIProxyAPI's isCodexFreePlanAuth).
export function isCodexFreePlan(providerSpecificData: unknown): boolean {
  if (!providerSpecificData || typeof providerSpecificData !== "object") return false;
  const plan = (providerSpecificData as { workspacePlanType?: unknown }).workspacePlanType;
  return typeof plan === "string" && plan.trim().toLowerCase() === "free";
}

type Tool = Record<string, unknown>;
type ToolOptions = { dropImageGeneration?: boolean; preserveCustomTools?: boolean };

function toolRecord(value: unknown): Tool | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Tool) : null;
}

function namespaceToolNames(tool: Tool, validToolNames: Set<string>): void {
  if (!Array.isArray(tool.tools)) return;
  for (const sub of tool.tools) {
    const subTool = toolRecord(sub);
    const name = typeof subTool?.name === "string" ? subTool.name.trim().slice(0, 128) : "";
    if (name) validToolNames.add(name);
  }
}

function functionProperty(tool: Tool, nested: Tool | null, key: string, type: string): unknown {
  if (typeof tool[key] === type) return tool[key];
  if (typeof nested?.[key] === type) return nested[key];
  return undefined;
}

function normalizeFunctionTool(tool: Tool, validToolNames: Set<string>): boolean {
  const nested = toolRecord(tool.function);
  const rawName = functionProperty(tool, nested, "name", "string") as string | undefined;
  const name = (rawName ?? "").trim();
  if (!name) return false;
  const description = functionProperty(tool, nested, "description", "string") ?? "";
  const parameters = toolRecord(tool.parameters) ??
    toolRecord(nested?.parameters) ?? { type: "object", properties: {} };
  const strict = functionProperty(tool, nested, "strict", "boolean");
  const deferLoading = functionProperty(tool, nested, "defer_loading", "boolean");
  // Flatten Chat function declarations to the Responses wire shape, preserving deferred tools.
  for (const key of Object.keys(tool)) delete tool[key];
  tool.type = "function";
  tool.name = name.slice(0, 128);
  if (description) tool.description = description;
  tool.parameters = parameters;
  if (strict !== undefined) tool.strict = strict;
  if (deferLoading !== undefined) tool.defer_loading = deferLoading;
  validToolNames.add(name);
  return true;
}

function keepHostedTool(tool: Tool, toolType: string, options?: ToolOptions): boolean {
  const hasFunctionObject = tool.function && typeof tool.function === "object";
  const hasName = typeof tool.name === "string";
  if (!toolType || hasFunctionObject || hasName) return false;
  if (CODEX_HOSTED_TOOL_TYPES.has(toolType)) {
    return !(toolType === "image_generation" && options?.dropImageGeneration === true);
  }
  console.debug(`[Codex] dropping unknown hosted tool type: ${toolType}`);
  return false;
}

function keepCodexTool(value: unknown, validNames: Set<string>, options?: ToolOptions): boolean {
  const tool = toolRecord(value);
  if (!tool) return false;
  const type = typeof tool.type === "string" ? tool.type : "";
  if (type === "namespace") {
    namespaceToolNames(tool, validNames);
    return true;
  }
  if (type === "custom" && options?.preserveCustomTools === true) {
    const name = typeof tool.name === "string" ? tool.name.trim().slice(0, 128) : "";
    if (!name) return false;
    tool.name = name;
    validNames.add(name);
    return true;
  }
  if (type === "function") return normalizeFunctionTool(tool, validNames);
  return keepHostedTool(tool, type, options);
}

function hasAdditionalTools(input: unknown): boolean {
  return (
    Array.isArray(input) &&
    input.some((item) => {
      const record = toolRecord(item);
      return (
        record?.type === "additional_tools" &&
        Array.isArray(record.tools) &&
        record.tools.length > 0
      );
    })
  );
}

function validateToolChoice(body: Tool, validNames: Set<string>): void {
  const choice = toolRecord(body.tool_choice);
  if (!choice) return;
  if (choice.type === "function") {
    const name = typeof choice.name === "string" ? choice.name.trim() : "";
    if (!name || !validNames.has(name)) delete body.tool_choice;
  } else if (choice.type === "local_shell") {
    delete body.tool_choice;
  }
}

export function normalizeCodexTools(body: Tool, options?: ToolOptions): void {
  if (!Array.isArray(body.tools)) {
    if (body.tool_choice === "auto" || body.tool_choice === "none") delete body.tool_choice;
    return;
  }
  const validNames = new Set<string>();
  body.tools = body.tools.filter((tool) => keepCodexTool(tool, validNames, options));
  // Responses Lite may carry its declarations in input[].additional_tools.
  if (
    (body.tools as unknown[]).length === 0 &&
    !hasAdditionalTools(body.input) &&
    (body.tool_choice === "auto" || body.tool_choice === "none")
  )
    delete body.tool_choice;
  validateToolChoice(body, validNames);
}
