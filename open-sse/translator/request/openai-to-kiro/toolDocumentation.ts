import { normalizeKiroToolSchema } from "./messageHelpers.ts";

type ToolDefinition = {
  name?: string;
  description?: string;
  parameters?: unknown;
  input_schema?: unknown;
  function?: { name?: string; description?: string; parameters?: unknown };
};

/** Keep oversized tool descriptions in prompt text, not in Kiro's tool schema. */
export function buildKiroToolSpecs(tools: ToolDefinition[]) {
  const docs: string[] = [];
  const specs = tools.map((tool) => {
    const name = tool.function?.name || tool.name;
    let description = tool.function?.description || tool.description || "";
    if (!description.trim()) description = `Tool: ${name}`;
    if (description.length > 10000) {
      docs.push(`## Tool: ${name}\n\n${description}`);
      description = `[Full documentation in system prompt under '## Tool: ${name}']`;
    }
    return {
      toolSpecification: {
        name,
        description,
        inputSchema: {
          json: normalizeKiroToolSchema(
            tool.function?.parameters || tool.parameters || tool.input_schema || {}
          ),
        },
      },
    };
  });
  return { specs, docs: docs.join("\n\n---\n\n") };
}

export function prependKiroToolDocs(content: string, docs: string): string {
  return `# Tool Documentation\n\n${docs}\n\n---\n\n${content}`;
}
