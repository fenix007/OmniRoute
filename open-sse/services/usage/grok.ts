import { z } from "zod";
import { parseResetTime, type UsageQuota } from "./quota.ts";

const billingSchema = z.object({
  config: z.object({
    creditUsagePercent: z.number().min(0).max(100).nullish(),
    currentPeriod: z
      .object({
        type: z.string(),
        start: z.string().optional(),
        end: z.string().optional(),
      })
      .nullish(),
    billingPeriodEnd: z.string().optional(),
  }),
});
const settingsSchema = z.object({ subscription_tier_display: z.string().optional() });
const origin = "https://cli-chat-proxy.grok.com";

export function buildGrokQuotas(payload: unknown, now = Date.now()): Record<string, UsageQuota> {
  const parsed = billingSchema.safeParse(payload);
  if (!parsed.success) return {};
  const config = parsed.data.config;
  const period = config.currentPeriod;
  if (period?.type !== "USAGE_PERIOD_TYPE_WEEKLY") return {};
  const resetAt = parseResetTime(period.end || config.billingPeriodEnd);
  const start = Date.parse(period.start || "");
  if (!resetAt || !Number.isFinite(start) || start > now || Date.parse(resetAt) <= now) return {};
  // The credits endpoint uses protobuf JSON: zero-valued scalar fields can be
  // omitted (or null). Only accept that default inside a valid active weekly period.
  const used = config.creditUsagePercent ?? 0;
  return {
    weekly: {
      used,
      total: 100,
      remaining: 100 - used,
      remainingPercentage: 100 - used,
      resetAt,
      unlimited: false,
    },
  };
}

export async function getGrokUsage(accessToken?: string) {
  if (!accessToken) return { message: "Grok OAuth token unavailable. Reconnect the account." };
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": "1.0.46",
    "x-grok-client-identifier": "grok-shell",
    "x-grok-client-mode": "cli",
  };
  try {
    const response = await fetch(`${origin}/v1/billing?format=credits`, {
      headers,
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!response.ok) {
      return {
        message:
          response.status === 401 || response.status === 403
            ? "Grok authorization expired or denied. Reconnect the account."
            : `Grok quota unavailable (HTTP ${response.status}).`,
      };
    }
    const quotas = buildGrokQuotas(await response.json());
    let plan: string | undefined;
    try {
      const settings = await fetch(`${origin}/v1/settings`, {
        headers,
        signal: AbortSignal.timeout(5_000),
        cache: "no-store",
      });
      if (settings.ok) {
        const parsed = settingsSchema.safeParse(await settings.json());
        if (parsed.success) plan = parsed.data.subscription_tier_display;
      }
    } catch {
      /* Plan metadata must not hide a valid quota. */
    }
    return {
      plan,
      quotas,
      ...(Object.keys(quotas).length === 0
        ? { message: "Grok did not report a current weekly quota. Try refreshing later." }
        : {}),
    };
  } catch {
    return { message: "Unable to fetch Grok quota. Try refreshing later." };
  }
}
