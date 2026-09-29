/**
 * ElevenLabs web-session authentication.
 *
 * elevenlabs.io signs users in with Firebase Auth (`browserLocalPersistence`), so the
 * durable session lives in Local Storage under `firebase:authUser:<apiKey>:[DEFAULT]`,
 * not in a cookie. The web app sends `Authorization: Bearer <Firebase ID token>` to
 * the ElevenLabs API. We import the Firebase refresh token and exchange it for
 * short-lived ID tokens through the public Secure Token API.
 */
import { createHash } from "node:crypto";

import { resolvePublicCred } from "../utils/publicCreds.ts";

export const ELEVENLABS_WEB_API_BASE_URL = "https://api.us.elevenlabs.io";
export const ELEVENLABS_FIREBASE_API_KEY_ENV = "ELEVENLABS_FIREBASE_API_KEY";

const FIREBASE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token";
const EXPIRY_SKEW_MS = 5 * 60_000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const UNRECOVERABLE_CODES = [
  "INVALID_REFRESH_TOKEN",
  "TOKEN_EXPIRED",
  "USER_DISABLED",
  "USER_NOT_FOUND",
  "INVALID_GRANT_TYPE",
  "MISSING_REFRESH_TOKEN",
];

export class ElevenLabsWebAuthError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ElevenLabsWebAuthError";
    this.status = status;
  }
}

export interface ElevenLabsWebSession {
  idToken: string;
  expiresAt: number;
  cached: boolean;
}

interface CacheEntry {
  idToken: string;
  expiresAt: number;
}

interface GetIdTokenOptions {
  forceRefresh?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const tokenCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

function readRefreshToken(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const sts = record.stsTokenManager as Record<string, unknown> | undefined;
  const candidate = sts?.refreshToken ?? record.refreshToken ?? record.refresh_token;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

/**
 * Accepts a raw Firebase refresh token, `refreshToken=<value>`, or the JSON value of
 * the `firebase:authUser:*` Local Storage entry. Returns the refresh token or null.
 */
export function parseElevenLabsWebCredential(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    try {
      return readRefreshToken(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  const assignment = /^(?:refreshToken|refresh_token)\s*[=:]\s*(.+)$/i.exec(trimmed);
  const token = (assignment ? assignment[1] : trimmed).trim().replace(/^"|"$/g, "");
  return /^[A-Za-z0-9_\-.]{20,}$/.test(token) ? token : null;
}

function cacheKey(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}

function firebaseErrorCode(text: string): string | null {
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message ?? parsed?.error;
    return typeof message === "string" ? message : null;
  } catch {
    return null;
  }
}

async function exchangeRefreshToken(
  refreshToken: string,
  fetchImpl: typeof fetch,
  now: () => number
): Promise<CacheEntry> {
  const apiKey = resolvePublicCred("elevenlabs_fb", ELEVENLABS_FIREBASE_API_KEY_ENV);
  const response = await fetchImpl(`${FIREBASE_TOKEN_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });

  if (!response.ok) {
    const code = firebaseErrorCode(await response.text());
    if (code && UNRECOVERABLE_CODES.some((known) => code.includes(known))) {
      throw new ElevenLabsWebAuthError(
        401,
        `ElevenLabs web session is no longer valid (${code}). Re-import the session from elevenlabs.io.`
      );
    }
    throw new ElevenLabsWebAuthError(
      502,
      `ElevenLabs web session refresh failed (${code || `HTTP ${response.status}`})`
    );
  }

  const data = (await response.json()) as Record<string, unknown>;
  const idToken = typeof data.id_token === "string" ? data.id_token : "";
  if (!idToken) {
    throw new ElevenLabsWebAuthError(502, "ElevenLabs web session refresh returned no ID token");
  }
  const expiresIn = Number.parseInt(String(data.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS), 10);
  const lifetimeSeconds =
    Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_EXPIRES_IN_SECONDS;
  return { idToken, expiresAt: now() + lifetimeSeconds * 1000 };
}

/**
 * Returns a Firebase ID token for the imported ElevenLabs web session, reusing a cached
 * token until five minutes before expiry and de-duplicating concurrent refreshes.
 */
export async function getElevenLabsWebIdToken(
  credential: unknown,
  { forceRefresh = false, fetchImpl = fetch, now = Date.now }: GetIdTokenOptions = {}
): Promise<ElevenLabsWebSession> {
  const refreshToken = parseElevenLabsWebCredential(credential);
  if (!refreshToken) {
    throw new ElevenLabsWebAuthError(
      401,
      "ElevenLabs web credential must be a Firebase refresh token or the firebase:authUser JSON from elevenlabs.io Local Storage"
    );
  }

  const key = cacheKey(refreshToken);
  const cached = tokenCache.get(key);
  if (!forceRefresh && cached && cached.expiresAt - EXPIRY_SKEW_MS > now()) {
    return { ...cached, cached: true };
  }

  let pending = inflight.get(key);
  if (!pending) {
    pending = exchangeRefreshToken(refreshToken, fetchImpl, now).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, pending);
  }

  try {
    const entry = await pending;
    tokenCache.set(key, entry);
    return { ...entry, cached: false };
  } catch (error) {
    tokenCache.delete(key);
    throw error;
  }
}

export function clearElevenLabsWebTokenCache(): void {
  tokenCache.clear();
  inflight.clear();
}
