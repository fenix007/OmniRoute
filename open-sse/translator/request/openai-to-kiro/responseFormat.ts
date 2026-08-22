// OpenAI `response_format` support for the OpenAI -> Kiro request translator.
import { wrapSystemReminder } from "./messageHelpers.ts";

/**
 * Marker the Kiro executor detects to learn that this request carries a JSON
 * contract. chatCore hands the executor the already-translated Kiro payload, so
 * `response_format` is no longer readable there — the prompt is the only channel
 * left, the same one `<thinking_mode>enabled</thinking_mode>` travels on.
 */
export const KIRO_JSON_CONTRACT_MARKER = "<response_format>json</response_format>";

/** The subset of OpenAI's `response_format` that asks for a JSON-only reply. */
type KiroResponseFormat = {
  type?: unknown;
  json_schema?: { schema?: unknown } | null;
};

/**
 * Kiro/CodeWhisperer has no Structured Output request parameter, so an OpenAI
 * `response_format` cannot be forwarded and used to be dropped without a trace:
 * the model saw nothing but the prompt and invented its own property names,
 * which fails every strict-schema caller closed. Describe the contract in the
 * prompt instead — the same fallback `openai-to-claude.ts` and
 * `DefaultExecutor.applyJsonSchemaFallback()` already apply on their routes.
 *
 * This is best-effort JSON, never constrained decoding: Kiro's only schema-
 * carrying channel is a tool schema, and `kiroSanitizer` must strip exactly the
 * keywords a strict schema depends on (`additionalProperties`, `$ref`/`$defs`,
 * `anyOf`) or Kiro 400s the request. Callers that need enforcement must route
 * to a provider with native Structured Output.
 *
 * Returns `null` when the request asks for no JSON contract.
 */
export function buildKiroJsonFormatInstruction(responseFormat: unknown): string | null {
  if (!responseFormat || typeof responseFormat !== "object" || Array.isArray(responseFormat)) {
    return null;
  }
  const fmt = responseFormat as KiroResponseFormat;
  const jsonOnly =
    "Respond with the JSON value only: no prose, no explanation, no markdown code fences.";

  if (fmt.type === "json_schema") {
    const schema = fmt.json_schema?.schema;
    if (!schema || typeof schema !== "object") return null;
    return (
      `${KIRO_JSON_CONTRACT_MARKER}\n` +
      "You must respond with valid JSON that strictly follows this JSON schema:\n" +
      "```json\n" +
      JSON.stringify(schema, null, 2) +
      "\n```\n" +
      "Use exactly the property names the schema defines — do not rename them, do not add " +
      "properties it does not define, and do not omit required ones. " +
      jsonOnly
    );
  }

  if (fmt.type === "json_object") {
    return `${KIRO_JSON_CONTRACT_MARKER}\nYou must respond with valid JSON. ${jsonOnly}`;
  }

  return null;
}

/**
 * Append the `response_format` contract to a Kiro user-message body, or return
 * the content untouched when the request asks for no JSON contract.
 */
export function appendKiroJsonFormatInstruction(content: string, responseFormat: unknown): string {
  const instruction = buildKiroJsonFormatInstruction(responseFormat);
  return instruction ? `${content}\n\n${wrapSystemReminder(instruction)}` : content;
}
