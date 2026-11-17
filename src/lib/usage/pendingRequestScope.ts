import {
  finalizePendingRequest,
  finalizePendingRequestById,
  updatePendingRequest,
  updatePendingRequestById,
  type PendingRequestMetadata,
} from "./usageHistory";

export type PendingRequestScope = {
  id: string | null | undefined;
  model: string;
  provider: string;
  connectionId: string | null;
};

export function updatePendingScope(scope: PendingRequestScope, metadata: PendingRequestMetadata) {
  if (scope.id) {
    updatePendingRequestById(scope.id, metadata);
  } else {
    updatePendingRequest(scope.model, scope.provider, scope.connectionId, metadata);
  }
}

export function finalizePendingScope(scope: PendingRequestScope, metadata: PendingRequestMetadata) {
  if (scope.id) {
    finalizePendingRequestById(scope.id, metadata);
  } else {
    finalizePendingRequest(scope.model, scope.provider, scope.connectionId, metadata);
  }
}
