import { z } from "zod";

/**
 * Pure parser for the Trae SOLO /authorize callback query string. Extracted
 * from route.ts so it can be unit-tested without touching the DB layer.
 *
 * Returns the credential bundle that the route hands to createProviderConnection,
 * or a structured error if the payload is missing/malformed.
 */
export type ParsedTraeCallback = {
  ok: true;
  record: {
    provider: "trae";
    authType: "oauth";
    accessToken: string;
    refreshToken: string | null;
    expiresAt: string | null;
    email: string | null;
    providerSpecificData: {
      userId: string;
      tenantId: string;
      bizUserId: string;
      userUniqueId: string;
      webId: string;
      scope: "marscode-us";
      tenant: "marscode";
      region: string;
      aiRegion: string;
      host: string;
      screenName: string | null;
      clientId: string;
      refreshExpireAt: number | null;
      authMethod: "oauth_callback";
    };
    testStatus: "active";
  };
};

export type ParseError = { ok: false; error: string };

const MAX_TOKEN_LENGTH = 32 * 1024;
const MAX_JSON_LENGTH = 64 * 1024;
const MAX_DATE_MS = 8_640_000_000_000_000;
const DEFAULT_TRAE_API_HOST = "https://api-us-east.trae.ai";

const traeUserJwtSchema = z.object({
  ClientID: z.string().trim().min(1).max(256).optional(),
  Token: z.string().min(1).max(MAX_TOKEN_LENGTH),
  RefreshToken: z.string().max(MAX_TOKEN_LENGTH).optional(),
  TokenExpireAt: z.number().int().nonnegative().max(MAX_DATE_MS).optional(),
  RefreshExpireAt: z.number().int().nonnegative().max(MAX_DATE_MS).optional(),
});

const traeUserInfoSchema = z.object({
  UserID: z.string().max(512).optional(),
  TenantID: z.string().max(512).optional(),
  Region: z.string().max(128).optional(),
  AIRegion: z.string().max(128).optional(),
  ScreenName: z.string().max(512).optional(),
  NonPlainTextEmail: z.string().max(512).optional(),
});

type JsonObjectResult = { ok: true; value: Record<string, unknown> } | ParseError;

function parseJsonObject(raw: string, label: string): JsonObjectResult {
  if (raw.length > MAX_JSON_LENGTH) return { ok: false, error: `${label} payload is too large` };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: `Malformed ${label} payload` };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: `Malformed ${label} payload` };
  }
}

function normalizeTraeApiHost(raw: string | null): string | ParseError {
  const candidate = raw || DEFAULT_TRAE_API_HOST;
  if (candidate.length > 512) return { ok: false, error: "Invalid Trae API host" };

  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    const approvedHostname =
      hostname === "api.trae.ai" || /^api-[a-z0-9]+(?:-[a-z0-9]+)*\.trae\.ai$/.test(hostname);
    if (
      url.protocol !== "https:" ||
      !approvedHostname ||
      url.username ||
      url.password ||
      url.port ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash
    ) {
      return { ok: false, error: "Invalid Trae API host" };
    }
    return url.origin;
  } catch {
    return { ok: false, error: "Invalid Trae API host" };
  }
}

export function parseTraeCallbackQuery(q: URLSearchParams): ParsedTraeCallback | ParseError {
  const userJwtRaw = q.get("userJwt");
  if (!userJwtRaw) return { ok: false, error: "Missing userJwt in callback" };

  const parsedUserJwt = parseJsonObject(userJwtRaw, "userJwt");
  if (!parsedUserJwt.ok) return parsedUserJwt;
  const userJwtResult = traeUserJwtSchema.safeParse(parsedUserJwt.value);
  if (!userJwtResult.success) return { ok: false, error: "Malformed userJwt payload" };
  const userJwt = userJwtResult.data;

  const flatRefresh = q.get("refreshToken");
  if (flatRefresh && flatRefresh.length > MAX_TOKEN_LENGTH) {
    return { ok: false, error: "Malformed refreshToken payload" };
  }
  const refresh = userJwt.RefreshToken || flatRefresh || null;
  const tokenExpiresAtMs = userJwt.TokenExpireAt || 0;
  const flatRefreshExpiresAt = q.get("refreshExpireAt");
  if (flatRefreshExpiresAt && !/^\d{1,16}$/.test(flatRefreshExpiresAt)) {
    return { ok: false, error: "Malformed refreshExpireAt payload" };
  }
  const refreshExpiresAtMs = userJwt.RefreshExpireAt || Number(flatRefreshExpiresAt) || 0;
  if (refreshExpiresAtMs > MAX_DATE_MS) {
    return { ok: false, error: "Malformed refreshExpireAt payload" };
  }

  let info: z.infer<typeof traeUserInfoSchema> = {};
  const userInfoRaw = q.get("userInfo");
  if (userInfoRaw) {
    const parsedUserInfo = parseJsonObject(userInfoRaw, "userInfo");
    if (!parsedUserInfo.ok) return parsedUserInfo;
    const userInfoResult = traeUserInfoSchema.safeParse(parsedUserInfo.value);
    if (!userInfoResult.success) return { ok: false, error: "Malformed userInfo payload" };
    info = userInfoResult.data;
  }

  const host = normalizeTraeApiHost(q.get("host"));
  if (typeof host !== "string") return host;

  const userId = info.UserID || "";
  const region = info.Region || "US-East";

  return {
    ok: true,
    record: {
      provider: "trae",
      authType: "oauth",
      accessToken: userJwt.Token,
      refreshToken: refresh,
      expiresAt: tokenExpiresAtMs ? new Date(tokenExpiresAtMs).toISOString() : null,
      email: info.NonPlainTextEmail || null,
      providerSpecificData: {
        userId,
        tenantId: info.TenantID || "",
        bizUserId: userId,
        userUniqueId: userId,
        webId: userId,
        scope: "marscode-us",
        tenant: "marscode",
        region,
        aiRegion: info.AIRegion || region,
        host,
        screenName: info.ScreenName || null,
        clientId: userJwt.ClientID || "en1oxy7wnw8j9n",
        refreshExpireAt: refreshExpiresAtMs || null,
        authMethod: "oauth_callback",
      },
      testStatus: "active",
    },
  };
}
