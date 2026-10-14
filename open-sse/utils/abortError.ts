/** Preserve caller-owned Error/DOMException reasons without writing to them. */
export function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "The operation was aborted", {
    cause: reason,
  });
  error.name = "AbortError";
  return error;
}
