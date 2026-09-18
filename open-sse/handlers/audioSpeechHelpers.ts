import { CORS_HEADERS } from "../utils/cors.ts";
import { isJsonObject, parseKieResultJson } from "../utils/kieTask.ts";
import { stripTrailingSlashes } from "../utils/urlSanitize.ts";

function extractUpstreamErrorMessage(parsed) {
  const detail = parsed?.detail;
  const candidates = [
    parsed?.err_msg,
    parsed?.error?.message,
    typeof parsed?.error === "string" ? parsed.error : null,
    parsed?.message,
    typeof detail === "string" ? detail : detail?.message,
  ];

  const raw = candidates.find(Boolean);
  return raw ? String(raw) : null;
}

export function upstreamErrorResponse(res, errText) {
  let errorMessage: string;
  try {
    const parsed = JSON.parse(errText);
    errorMessage =
      extractUpstreamErrorMessage(parsed) || errText || `Upstream error (${res.status})`;
  } catch {
    errorMessage = errText || `Upstream error (${res.status})`;
  }

  return Response.json(
    { error: { message: errorMessage, code: res.status } },
    {
      status: res.status,
      headers: { ...CORS_HEADERS },
    }
  );
}

export function audioStreamResponse(res, defaultContentType = "audio/mpeg") {
  const contentType = res.headers.get("content-type") || defaultContentType;
  return new Response(res.body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": contentType,
      "Transfer-Encoding": "chunked",
    },
  });
}

export function normalizeKieElevenLabsVoice(voice: unknown): string {
  const value = typeof voice === "string" ? voice.trim() : "";
  const aliases: Record<string, string> = {
    alloy: "Rachel",
    echo: "Adam",
    fable: "Brian",
    onyx: "Antoni",
    nova: "Bella",
    shimmer: "Dorothy",
  };
  return aliases[value.toLowerCase()] || value || "Rachel";
}

function findAudioUrlDeep(value: unknown): string | null {
  if (!value) return null;

  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value) && !/\.(jpg|jpeg|png|webp|gif|svg)(\?|$)/i.test(value)) {
      return value;
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const url = findAudioUrlDeep(item);
      if (url) return url;
    }
    return null;
  }

  if (isJsonObject(value)) {
    const preferredKeys = [
      "audio_url",
      "audioUrl",
      "stream_audio_url",
      "streamAudioUrl",
      "resultUrl",
      "url",
      "downloadUrl",
      "resultUrls",
    ];

    for (const key of preferredKeys) {
      const url = findAudioUrlDeep(value[key]);
      if (url) return url;
    }

    for (const item of Object.values(value)) {
      const url = findAudioUrlDeep(item);
      if (url) return url;
    }
  }

  return null;
}

export function findKieAudioUrl(recordData: unknown): string | null {
  const record = isJsonObject(recordData) ? recordData : {};
  const data = isJsonObject(record.data) ? record.data : {};
  const resultJson = parseKieResultJson(recordData);
  const response = data.response;
  const nestedData = data.data;
  const candidates = [
    response,
    data,
    resultJson,
    ...(Array.isArray(response) ? response : []),
    ...(Array.isArray(nestedData) ? nestedData : []),
    ...(Array.isArray(resultJson.data) ? resultJson.data : []),
    ...(Array.isArray(resultJson.result) ? resultJson.result : []),
  ];

  for (const item of candidates) {
    const url = findAudioUrlDeep(item);
    if (url) return url;
  }

  return null;
}

export function isValidPathSegment(segment: string): boolean {
  return !segment.includes("..") && !segment.includes("//");
}

export function getStringValue(value): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function getInferenceShAudioUrl(task: unknown): string | null {
  if (!isJsonObject(task) || !isJsonObject(task.output)) return null;
  const audio = task.output.audio;
  if (typeof audio !== "string" || !audio.trim()) return null;

  try {
    const url = new URL(audio);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function isInferenceShTaskTerminal(task: unknown): boolean {
  if (!isJsonObject(task)) return true;
  const status = task.status;
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === 10 ||
    status === 11 ||
    status === 12
  );
}

export function getInferenceShTask(taskEnvelope: unknown): Record<string, unknown> | null {
  const task =
    isJsonObject(taskEnvelope) && "data" in taskEnvelope ? taskEnvelope.data : taskEnvelope;
  return isJsonObject(task) ? task : null;
}

export function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function getAwsPollyProviderData(credentials) {
  return credentials?.providerSpecificData &&
    typeof credentials.providerSpecificData === "object" &&
    !Array.isArray(credentials.providerSpecificData)
    ? credentials.providerSpecificData
    : {};
}

export function resolveAwsPollyRegion(providerSpecificData) {
  return (
    getStringValue(providerSpecificData.region) ||
    getStringValue(providerSpecificData.awsRegion) ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    "us-east-1"
  );
}

export function resolveAwsPollyBaseUrl(providerSpecificData, region) {
  const configuredBaseUrl = getStringValue(providerSpecificData.baseUrl);
  const baseUrl = configuredBaseUrl || `https://polly.${region}.amazonaws.com`;
  return stripTrailingSlashes(baseUrl.replace(/\/v1\/speech\/?$/i, ""));
}

export function getProviderSpecificData(credentials) {
  return credentials?.providerSpecificData &&
    typeof credentials.providerSpecificData === "object" &&
    !Array.isArray(credentials.providerSpecificData)
    ? credentials.providerSpecificData
    : {};
}

export function normalizeXiaomiMimoSpeechUrl(baseUrl) {
  const configured = getStringValue(baseUrl) || "https://api.xiaomimimo.com/v1";
  const normalized = stripTrailingSlashes(configured).replace(/\/chat\/completions$/i, "");
  return `${normalized}/chat/completions`;
}

export function normalizeXiaomiMimoMimeType(format) {
  switch (getStringValue(format)?.toLowerCase()) {
    case undefined:
    case null:
    case "mp3":
    case "audio/mp3":
    case "audio/mpeg":
      return "audio/mpeg";
    case "wav":
    case "audio/wav":
      return "audio/wav";
    default:
      return null;
  }
}

export function getXiaomiMimoAudioData(data) {
  const messageAudio = data?.choices?.[0]?.message?.audio;
  const directAudio = data?.audio || data?.output_audio;
  const firstDataItem = Array.isArray(data?.data) ? data.data[0] : null;

  return (
    getStringValue(messageAudio?.data) ||
    getStringValue(messageAudio?.b64_json) ||
    getStringValue(directAudio?.data) ||
    getStringValue(directAudio?.b64_json) ||
    getStringValue(firstDataItem?.b64_json) ||
    getStringValue(firstDataItem?.audio) ||
    getStringValue(data?.audioContent) ||
    getStringValue(data?.audio_content)
  );
}

export function normalizeAwsPollyEngine(modelId) {
  const engine = getStringValue(modelId) || "standard";
  return ["standard", "neural", "long-form", "generative"].includes(engine) ? engine : "standard";
}

export function normalizeAwsPollyOutputFormat(responseFormat) {
  const format = getStringValue(responseFormat)?.toLowerCase();
  switch (format) {
    case "pcm":
    case "wav":
      return "pcm";
    case "opus":
    case "ogg_opus":
      return "ogg_opus";
    case "ogg":
    case "ogg_vorbis":
      return "ogg_vorbis";
    case "json":
      return "json";
    case "mp3":
    default:
      return "mp3";
  }
}

export function normalizeAwsPollyTextType(body) {
  const explicitTextType = getStringValue(body.text_type || body.textType)?.toLowerCase();
  if (explicitTextType === "ssml") return "ssml";
  if (explicitTextType === "text") return "text";

  const input = getStringValue(body.input) || "";
  return input.trim().startsWith("<speak") ? "ssml" : "text";
}

export function getAwsPollySampleRate(responseFormat, sampleRate) {
  const explicit = getStringValue(sampleRate || null);
  if (explicit) return explicit;

  const outputFormat = normalizeAwsPollyOutputFormat(responseFormat);
  if (outputFormat === "ogg_opus") return "48000";
  if (outputFormat === "pcm") return "16000";
  return undefined;
}
