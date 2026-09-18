export function buildFormParams(entries: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === "string" && value.length > 0) {
      params.set(key, value);
    }
  }
  return params;
}

/** OAuth2 error codes that prove a refresh token is permanently unusable. */
const UNRECOVERABLE_OAUTH_ERROR_CODES = new Set([
  "invalid_grant",
  "invalid_request",
  "refresh_token_reused",
  "invalid_token",
  "expired_token",
  "unauthorized_client",
  "access_denied",
]);

/**
 * Extract a canonical unrecoverable OAuth error from plain, nested, or encoded bodies.
 * Transient error codes are deliberately excluded.
 */
export function extractOAuthErrorCode(raw: unknown, depth = 0): string | null {
  if (raw == null || depth > 6) return null;

  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) return null;
    if (UNRECOVERABLE_OAUTH_ERROR_CODES.has(value)) return value;
    if (value[0] === "{" || value[0] === "[" || value[0] === '"') {
      try {
        const nested = extractOAuthErrorCode(JSON.parse(value), depth + 1);
        if (nested) return nested;
      } catch {
        // The value is not JSON; continue with the narrowly scoped field scan.
      }
    }
    const match = value.match(/"error(?:_code)?"\s*:\s*"([a-z_]+)"/i);
    if (match && UNRECOVERABLE_OAUTH_ERROR_CODES.has(match[1])) return match[1];
    return null;
  }

  if (typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    return (
      extractOAuthErrorCode(value.error, depth + 1) ??
      extractOAuthErrorCode(value.code, depth + 1) ??
      extractOAuthErrorCode(value.error_code, depth + 1)
    );
  }

  return null;
}
