export function getResponsesSubpath(endpointPath: unknown): string | null {
  let normalizedEndpoint = String(endpointPath || "");
  while (normalizedEndpoint.endsWith("/") && normalizedEndpoint.length > 0) {
    normalizedEndpoint = normalizedEndpoint.slice(0, -1);
  }

  const lower = normalizedEndpoint.toLowerCase();
  if (lower === "responses" || lower.endsWith("/responses")) {
    return "";
  }

  const responsesSlash = "/responses/";
  const idx = lower.lastIndexOf(responsesSlash);
  if (idx !== -1) {
    return normalizedEndpoint.slice(idx + "/responses".length);
  }

  if (lower.startsWith("responses/")) {
    return normalizedEndpoint.slice("responses".length);
  }

  return null;
}

export function isCompactResponsesEndpoint(endpointPath: unknown): boolean {
  return getResponsesSubpath(endpointPath)?.toLowerCase() === "/compact";
}
