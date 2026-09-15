export const CODEX_RESPONSES_WEBSOCKET_BETA = "responses_websockets=2026-02-06";

export function normalizeCodexWsHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  let websocketBeta: string | null = null;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "upgrade" ||
      lower === "sec-websocket-key" ||
      lower === "sec-websocket-version" ||
      lower === "sec-websocket-extensions"
    ) {
      continue;
    }
    if (lower === "openai-beta") {
      if (value.includes("responses_websockets=")) websocketBeta = value;
      continue;
    }
    result[key] = value;
  }
  result["OpenAI-Beta"] = websocketBeta || CODEX_RESPONSES_WEBSOCKET_BETA;
  result.Origin = "https://chatgpt.com";
  return result;
}
