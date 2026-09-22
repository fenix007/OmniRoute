import { normalizeUpstreamFailure } from "../translator/response/openai-responses/pureHelpers.ts";

/** Classify buffered Responses terminal failures before they can become chat success. */
export function getResponsesTerminalError(
  body: unknown
): { message: string; code: string; status: number; type: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const response = body as Record<string, unknown>;
  if (response.object !== "response") return null;
  const status = response.status;
  const failed = status === "failed" || status === "cancelled" || status === "canceled";
  const incomplete = status === "incomplete";
  const error = response.error;
  if (!failed && !incomplete && error == null) return null;

  // Token-limited partial text is still meaningful (finish_reason=length). An
  // incomplete tool call must never reach tool execution with truncated arguments.
  if (incomplete && error == null && Array.isArray(response.output)) {
    const details = response.incomplete_details as Record<string, unknown> | undefined;
    const expectedLimit =
      details?.reason === "max_output_tokens" || details?.reason === "content_filter";
    const hasToolCall = response.output.some((item) => item?.type === "function_call");
    const hasText = response.output.some(
      (item) =>
        item?.type === "message" &&
        Array.isArray(item.content) &&
        item.content.some(
          (part) =>
            part?.type === "output_text" && typeof part.text === "string" && part.text.trim()
        )
    );
    if (expectedLimit && hasText && !hasToolCall) return null;
  }

  const detail = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const fallbackCode = failed || incomplete ? `response_${status}` : "response_failed";
  // Code is an identifier, not an arbitrary provider string crossing the boundary.
  const code =
    typeof detail.code === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(detail.code)
      ? detail.code
      : fallbackCode;
  const message =
    typeof detail.message === "string" && detail.message.trim()
      ? detail.message
      : typeof error === "string" && error.trim()
        ? error
        : `Provider returned a ${String(status || "failed")} response`;
  // The caller uses createErrorResult, which sanitizes this upstream message.
  return normalizeUpstreamFailure({ error: { message, code } }, "upstream_response_error");
}
