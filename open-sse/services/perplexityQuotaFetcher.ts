/**
 * Perplexity Web (session cookie) remaining-query counters.
 *
 * The web app reads them from GET /rest/rate-limit/all, e.g.
 *   {"remaining_pro":193,"remaining_research":0,"remaining_labs":25,
 *    "remaining_agentic_research":0,"model_specific_limits":{}}
 * Only remaining counts are exposed — Perplexity publishes no totals or reset
 * times (Pro Deep Research is ~20/month since Feb 2026), so consumers must not
 * derive percentages from these numbers.
 *
 * Cloudflare challenges plain GETs from the edge; the request needs the Firefox
 * TLS fingerprint plus same-origin browser headers. Fail-open: any failure
 * returns null and callers proceed as if the quota were unknown.
 */

import { tlsFetchPerplexity } from "./perplexityTlsClient.ts";

export const PPLX_RATE_LIMIT_URL =
  "https://www.perplexity.ai/rest/rate-limit/all?version=2.18&source=default";

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;

export interface PerplexityRateLimits {
  pro: number | null;
  research: number | null;
  agenticResearch: number | null;
  labs: number | null;
  fetchedAt: string;
}

interface CacheEntry {
  limits: PerplexityRateLimits;
  at: number;
}

const cache = new Map<string, CacheEntry>();

export interface PerplexityAuth {
  apiKey?: string | null;
  accessToken?: string | null;
}

function authHeaders(auth: PerplexityAuth): Record<string, string> | null {
  if (auth.accessToken) return { Authorization: `Bearer ${auth.accessToken}` };
  if (auth.apiKey) return { Cookie: `__Secure-next-auth.session-token=${auth.apiKey}` };
  return null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

export function parsePerplexityRateLimits(body: unknown): PerplexityRateLimits | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const limits: PerplexityRateLimits = {
    pro: count(b.remaining_pro),
    research: count(b.remaining_research),
    agenticResearch: count(b.remaining_agentic_research),
    labs: count(b.remaining_labs),
    fetchedAt: new Date().toISOString(),
  };
  const known = [limits.pro, limits.research, limits.agenticResearch, limits.labs];
  return known.some((v) => v !== null) ? limits : null;
}

/**
 * Remaining counters for one connection, cached for 60s per connection.
 * `forceRefresh` bypasses the cache (dashboard refresh button).
 */
export async function fetchPerplexityRateLimits(
  connectionId: string,
  auth: PerplexityAuth,
  options: { forceRefresh?: boolean } = {}
): Promise<PerplexityRateLimits | null> {
  const headers = authHeaders(auth);
  if (!headers || !connectionId) return null;

  const cached = cache.get(connectionId);
  if (!options.forceRefresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.limits;
  }

  try {
    const res = await tlsFetchPerplexity(PPLX_RATE_LIMIT_URL, {
      method: "GET",
      headers: {
        Accept: "*/*",
        Origin: "https://www.perplexity.ai",
        Referer: "https://www.perplexity.ai/",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0",
        ...headers,
      },
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (res.status !== 200 || !res.text) return null;
    const limits = parsePerplexityRateLimits(JSON.parse(res.text));
    if (limits) cache.set(connectionId, { limits, at: Date.now() });
    return limits;
  } catch {
    return null;
  }
}

/** Drop the cached counters, e.g. after a Deep Research run consumed one. */
export function invalidatePerplexityRateLimits(connectionId: string | null | undefined): void {
  if (connectionId) cache.delete(connectionId);
}

export function __resetPerplexityRateLimitCacheForTesting(): void {
  cache.clear();
}
