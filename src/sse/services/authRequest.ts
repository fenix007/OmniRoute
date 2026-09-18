type AuthRequestHeaders = Headers | Record<string, string | string[] | undefined>;

type AuthRequestLike = {
  headers?: AuthRequestHeaders | null;
  url?: string | null;
};

export function readHeaderValue(
  headers:
    | Headers
    | { get?: (name: string) => string | null }
    | Record<string, string | string[] | undefined>
    | null
    | undefined,
  name: string
): string | null {
  if (!headers) return null;

  if (typeof (headers as Headers).get === "function") {
    const value = (headers as Headers).get(name) || (headers as Headers).get(name.toLowerCase());
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  const recordHeaders = headers as Record<string, string | string[] | undefined>;
  const value =
    recordHeaders[name] || recordHeaders[name.toLowerCase()] || recordHeaders[name.toUpperCase()];

  if (Array.isArray(value)) {
    return typeof value[0] === "string" && value[0].trim().length > 0 ? value[0].trim() : null;
  }

  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNonEmptyUrlToken(request: AuthRequestLike): string | null {
  if (typeof request?.url !== "string" || request.url.trim().length === 0) return null;

  try {
    const url = new URL(request.url, "http://localhost");
    const segments = url.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);

    if (segments[0] === "vscode" && segments[1]) {
      const decodedSegment = decodeURIComponent(segments[1]).trim();
      if (decodedSegment.length > 0) return decodedSegment;
    }

    if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "vscode") {
      if (segments[3] && segments[3] !== "raw" && segments[3] !== "combos") {
        const decodedSegment = decodeURIComponent(segments[3]).trim();
        if (decodedSegment.length > 0) return decodedSegment;
      }

      if ((segments[3] === "raw" || segments[3] === "combos") && segments[4]) {
        const decodedSegment = decodeURIComponent(segments[4]).trim();
        if (decodedSegment.length > 0) return decodedSegment;
      }
    }

    // Query-string token fallbacks are intentionally excluded: credentials in URLs
    // leak into access logs, Referer headers, and proxy logs.
  } catch {
    return null;
  }

  return null;
}

/** Extract an API key from explicit auth headers or an allowed VS Code URL path. */
export function extractApiKey(request: AuthRequestLike, opts?: { allowUrl?: boolean }) {
  const authHeader =
    readHeaderValue(request?.headers, "Authorization") ||
    readHeaderValue(request?.headers, "authorization");
  if (typeof authHeader === "string") {
    const trimmedHeader = authHeader.trim();
    if (trimmedHeader.toLowerCase().startsWith("bearer ")) {
      return trimmedHeader.slice(7).trim() || null;
    }
  }

  // Anthropic Messages API clients authenticate via x-api-key. Scope this fallback
  // to callers carrying anthropic-version so unrelated placeholder keys are ignored.
  const anthropicVersion =
    readHeaderValue(request?.headers, "anthropic-version") ||
    readHeaderValue(request?.headers, "Anthropic-Version");
  if (anthropicVersion) {
    const xApiKey =
      readHeaderValue(request?.headers, "x-api-key") ||
      readHeaderValue(request?.headers, "X-Api-Key");
    if (typeof xApiKey === "string") {
      const trimmed = xApiKey.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }

  if (opts?.allowUrl === false) return null;
  return readNonEmptyUrlToken(request);
}
