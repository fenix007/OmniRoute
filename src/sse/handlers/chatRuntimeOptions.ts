import type { ComboAccountSelection } from "@omniroute/open-sse/services/combo/types.ts";
import type { EmptyResponseRetryBudget } from "@omniroute/open-sse/services/combo/emptyResponseRetryBudget.ts";
import type { SessionSource } from "@/lib/usage/sessionRouting";

/** Server-derived selection and retry context carried across combo dispatches. */
export type ChatRuntimeOptions = ComboAccountSelection & {
  emptyResponseBudget?: EmptyResponseRetryBudget;
  emergencyFallbackTried?: boolean;
  forceLiveComboTest?: boolean;
  sessionId?: string | null;
  sessionAffinityKey?: string | null;
  sessionSource?: SessionSource;
  modelPinned?: boolean;
  forcedConnectionId?: string | null;
  allowedConnectionIds?: string[] | null;
  comboStepId?: string | null;
  comboExecutionKey?: string | null;
  skipUpstreamRetry?: boolean;
  allowRateLimitedConnection?: boolean;
  preselectedCredentials?: any;
  cachedSettings?: any;
  providerId?: string | null;
  correlationId?: string | null;
  modelAbortSignal?: AbortSignal | null;
};
