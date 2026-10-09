import { saveCallLog } from "@/lib/usageDb";

export function saveImageSuccessResult({
  provider,
  model,
  connectionId = null,
  startTime,
  requestBody = null,
  responseBody = null,
  created = null,
  images,
  path = "/v1/images/generations",
}) {
  saveCallLog({
    method: "POST",
    path,
    status: 200,
    model: `${provider}/${model}`,
    provider,
    connectionId,
    duration: Date.now() - startTime,
    requestBody,
    responseBody,
  }).catch(() => {});

  return {
    success: true,
    data: {
      created: created || Math.floor(Date.now() / 1000),
      data: images,
    },
  };
}

export function saveImageErrorResult({
  provider,
  model,
  connectionId = null,
  status,
  startTime,
  error,
  failureCode = null,
  failureKind = null,
  upstreamCode = null,
  diagnostics = null,
  deferLog = false,
  durationMs = null,
  requestBody = null,
  path = "/v1/images/generations",
}) {
  if (!deferLog)
    saveCallLog({
      method: "POST",
      path,
      status,
      model: `${provider}/${model}`,
      provider,
      connectionId,
      duration: durationMs ?? Date.now() - startTime,
      error:
        `${typeof error === "string" ? error : String(error)}${diagnostics ? ` [${diagnostics}]` : ""}`.slice(
          0,
          500
        ),
      requestBody,
    }).catch(() => {});

  return {
    success: false,
    status,
    error,
    failureCode,
    failureKind,
    upstreamCode,
    ...(deferLog
      ? {
          deferredCallLog: {
            provider,
            model,
            connectionId,
            status,
            startTime,
            error,
            failureCode,
            failureKind,
            upstreamCode,
            diagnostics,
            durationMs: Date.now() - startTime,
            requestBody,
            path,
          },
        }
      : {}),
  };
}

export function finalizeImageErrorResult(result) {
  return result?.deferredCallLog ? saveImageErrorResult(result.deferredCallLog) : result;
}
