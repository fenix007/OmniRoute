const TERMINAL_CODEX_OAUTH_MARKERS = [
  "invalidated oauth token",
  "authentication token has been invalidated",
] as const;

function normalizeErrorText(value: unknown): string {
  if (typeof value === "string") return value.toLowerCase();
  if (value == null) return "";

  try {
    return JSON.stringify(value).toLowerCase();
  } catch {
    return "";
  }
}

/**
 * OpenAI emits these messages only after permanently invalidating the OAuth
 * credential. Refreshing the same token cannot recover it, so the connection
 * should be expired immediately and combo routing should move to the next one.
 */
export function isTerminalCodexOAuthFailure(params: {
  provider: string;
  status: number;
  message?: unknown;
  responseBody?: unknown;
}): boolean {
  if (params.provider !== "codex" || params.status !== 401) return false;

  const errorText = `${normalizeErrorText(params.message)} ${normalizeErrorText(
    params.responseBody
  )}`;
  return TERMINAL_CODEX_OAUTH_MARKERS.some((marker) => errorText.includes(marker));
}
