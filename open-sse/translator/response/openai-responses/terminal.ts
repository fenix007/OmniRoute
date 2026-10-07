import { buildErrorBody } from "../../../utils/error.ts";

interface TerminalState {
  completedSent?: boolean;
  completedOutputItems?: Array<{ output_index: number; seq: number; item: unknown }>;
  upstreamError?: { status?: number; message?: unknown };
  responseId?: string;
  created?: number;
  model?: string;
  usage?: unknown;
}

// Preserve the frozen output ordering and success contract; failures have their own terminal.
export function sendCompleted(
  state: TerminalState,
  emit: (event: string, data: Record<string, unknown>) => void
) {
  if (state.completedSent) return;
  state.completedSent = true;
  const output = (state.completedOutputItems || [])
    .slice()
    .sort((left, right) => left.output_index - right.output_index || left.seq - right.seq)
    .map(({ item }) => item);
  const failure = state.upstreamError;
  const response: Record<string, unknown> = {
    id: state.responseId,
    object: "response",
    created_at: state.created,
    status: failure ? "failed" : "completed",
    background: false,
    error: failure
      ? {
          code: String(failure.status ?? ""),
          message: buildErrorBody(failure.status || 502, String(failure.message ?? "")).error
            .message,
        }
      : null,
    output,
  };
  if (state.model) response.model = state.model;
  if (state.usage) response.usage = state.usage;
  const event = failure ? "response.failed" : "response.completed";
  emit(event, { type: event, response });
}
