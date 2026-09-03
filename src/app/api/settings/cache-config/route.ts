import { NextRequest, NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { getUserDatabaseSettings, updateDatabaseSettings } from "@/lib/db/databaseSettings";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { z } from "zod";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

const cacheConfigUpdateSchema = z.object({
  semanticCacheEnabled: z.boolean().optional(),
  semanticCacheMaxSize: z.number().int().min(10).max(1000).optional(),
  semanticCacheTTL: z.number().int().min(60000).optional(),
  promptCacheEnabled: z.boolean().optional(),
  promptCacheStrategy: z.enum(["auto", "system-only", "manual"]).optional(),
  alwaysPreserveClientCache: z.enum(["auto", "always", "never"]).optional(),
  idempotencyWindowMs: z.number().positive().optional(),
});

const CACHE_CONFIG_KEYS = [
  "semanticCacheEnabled",
  "semanticCacheMaxSize",
  "semanticCacheTTL",
  "promptCacheEnabled",
  "promptCacheStrategy",
  "alwaysPreserveClientCache",
  "idempotencyWindowMs",
] as const;

const DEFAULTS = {
  semanticCacheEnabled: true,
  semanticCacheMaxSize: 100,
  semanticCacheTTL: 1800000,
  promptCacheEnabled: true,
  promptCacheStrategy: "auto",
  alwaysPreserveClientCache: "auto",
  idempotencyWindowMs: 5000,
};

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const settings = await getSettings();
    const databaseCache = getUserDatabaseSettings().cache;
    const config: Record<string, unknown> = {};
    for (const key of CACHE_CONFIG_KEYS) {
      config[key] =
        key === "idempotencyWindowMs" || key === "alwaysPreserveClientCache"
          ? (settings[key] ?? DEFAULTS[key])
          : (databaseCache[key] ?? settings[key] ?? DEFAULTS[key]);
    }
    return NextResponse.json(config);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const validation = validateBody(cacheConfigUpdateSchema, rawBody);
    if (isValidationFailure(validation)) {
      return validation.response;
    }

    const settingsUpdates: Record<string, unknown> = {};
    const cacheUpdates: Partial<ReturnType<typeof getUserDatabaseSettings>["cache"]> = {};
    const body = validation.data;

    if (body.semanticCacheEnabled !== undefined) {
      cacheUpdates.semanticCacheEnabled = body.semanticCacheEnabled;
    }
    if (body.semanticCacheMaxSize !== undefined) {
      cacheUpdates.semanticCacheMaxSize = body.semanticCacheMaxSize;
    }
    if (body.semanticCacheTTL !== undefined) {
      cacheUpdates.semanticCacheTTL = body.semanticCacheTTL;
    }
    if (body.promptCacheEnabled !== undefined) {
      cacheUpdates.promptCacheEnabled = body.promptCacheEnabled;
    }
    if (body.promptCacheStrategy !== undefined) {
      cacheUpdates.promptCacheStrategy = body.promptCacheStrategy;
    }
    if (body.alwaysPreserveClientCache !== undefined) {
      settingsUpdates.alwaysPreserveClientCache = body.alwaysPreserveClientCache;
    }
    if (body.idempotencyWindowMs !== undefined) {
      settingsUpdates.idempotencyWindowMs = body.idempotencyWindowMs;
    }

    if (Object.keys(cacheUpdates).length > 0) {
      updateDatabaseSettings({
        cache: { ...getUserDatabaseSettings().cache, ...cacheUpdates },
      });
    }
    if (Object.keys(settingsUpdates).length > 0) {
      await updateSettings(settingsUpdates);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
