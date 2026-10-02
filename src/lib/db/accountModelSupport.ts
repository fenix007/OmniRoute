import { createHash } from "node:crypto";
import { z } from "zod";
import { getCodexUpstreamModel } from "@omniroute/open-sse/config/codexModels.ts";
import { getCodexClientVersion } from "@omniroute/open-sse/config/codexClient.ts";
import { getDbInstance } from "./core";

export type ModelSupportConnection = {
  id?: string;
  connectionId?: string;
  provider?: string;
  accessToken?: string | null;
  apiKey?: string | null;
  providerSpecificData?: Record<string, unknown>;
};

const supportSchema = z.object({
  model: z.string(),
  status: z.enum(["supported", "unsupported", "unknown"]),
  reason: z.string(),
  httpStatus: z.number().nullable(),
  checkedAt: z.number(),
  expiresAt: z.number(),
  identity: z.string(),
});
export type AccountModelSupport = z.infer<typeof supportSchema>;
const NAMESPACE = "accountModelSupport";

export function normalizeAccountModel(provider: string, model: string): string {
  return provider === "codex" || provider === "cx"
    ? getCodexUpstreamModel(model.replace(/^(?:codex|cx)\//, ""))
    : model;
}

/** Invalidates evidence after reauthentication, token refresh, workspace or plan changes. */
export function accountModelCredentialIdentity(connection: ModelSupportConnection): string {
  const token = connection.accessToken || connection.apiKey || "";
  const data = connection.providerSpecificData || {};
  // Credentials are fingerprinted without storing or logging the secret.
  return createHash("sha256")
    .update(
      JSON.stringify([
        token,
        data.workspaceId,
        data.chatgptAccountId,
        data.workspacePlanType,
        getCodexClientVersion(),
      ])
    )
    .digest("hex");
}

function supportKey(provider: string, connection: ModelSupportConnection, model: string): string {
  return JSON.stringify([
    provider === "cx" ? "codex" : provider,
    connection.connectionId || connection.id,
    normalizeAccountModel(provider, model),
  ]);
}

export function getAccountModelSupport(
  provider: string,
  connection: ModelSupportConnection,
  model: string,
  now = Date.now()
): AccountModelSupport | null {
  try {
    const row = getDbInstance()
      .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
      .get(NAMESPACE, supportKey(provider, connection, model)) as { value?: string } | undefined;
    if (!row?.value) return null;
    const parsed = supportSchema.safeParse(JSON.parse(row.value));
    return parsed.success &&
      parsed.data.expiresAt > now &&
      parsed.data.identity === accountModelCredentialIdentity(connection)
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

export function saveAccountModelSupport(
  provider: string,
  connection: ModelSupportConnection,
  model: string,
  result: Pick<AccountModelSupport, "status" | "reason" | "httpStatus">,
  now = Date.now()
): AccountModelSupport {
  const ttl =
    result.status === "unknown"
      ? 60_000
      : result.status === "supported"
        ? 6 * 60 * 60_000
        : result.httpStatus === 404
          ? 15 * 60_000
          : 24 * 60 * 60_000;
  const record: AccountModelSupport = {
    ...result,
    model: normalizeAccountModel(provider, model),
    checkedAt: now,
    expiresAt: now + ttl,
    identity: accountModelCredentialIdentity(connection),
  };
  try {
    const db = getDbInstance();
    db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
      NAMESPACE,
      supportKey(provider, connection, model),
      JSON.stringify(record)
    );
  } catch {
    // A cache failure must not interrupt account fallback or the current diagnosis.
    console.warn("[MODEL_DIAGNOSTICS] Could not persist account/model support cache");
  }
  return record;
}

export function publicModelSupport(result: AccountModelSupport) {
  const { identity: _identity, ...diagnosis } = result;
  return diagnosis;
}
