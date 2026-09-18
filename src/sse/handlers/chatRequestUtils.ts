function normalizeAllowedConnectionIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0
  );
  return ids.length > 0 ? ids : null;
}

export function intersectAllowedConnectionIds(
  primary: unknown,
  secondary: unknown
): string[] | null {
  const first = normalizeAllowedConnectionIds(primary);
  const second = normalizeAllowedConnectionIds(secondary);

  if (first && second) {
    return first.filter((id) => second.includes(id));
  }

  return first || second || null;
}

export function hasNonObjectMessageEntry(messages: unknown[]): boolean {
  return messages.some(
    (message) => message === null || typeof message !== "object" || Array.isArray(message)
  );
}

export async function readResponseErrorReason(response: Response): Promise<string | null> {
  try {
    const payload = (await response.clone().json()) as {
      error?: { message?: unknown } | unknown;
    };
    const message =
      payload.error &&
      typeof payload.error === "object" &&
      typeof (payload.error as { message?: unknown }).message === "string"
        ? (payload.error as { message: string }).message
        : null;
    return message?.trim() || null;
  } catch {
    return null;
  }
}
