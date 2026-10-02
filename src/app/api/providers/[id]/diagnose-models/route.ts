import { z } from "zod";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { getProviderConnectionById } from "@/lib/db/providers";
import { getModelsByProviderId } from "@/shared/constants/models";
import { diagnoseAccountModel } from "@/sse/services/accountModelDiagnostics";
import { normalizeAccountModel, publicModelSupport } from "@/lib/db/accountModelSupport";

const requestSchema = z
  .object({
    models: z.array(z.string().trim().min(1).max(200)).min(1).max(32).optional(),
    refresh: z.boolean().default(false),
  })
  .strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await isAuthenticated(request)))
    return Response.json({ error: "Authentication required" }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success)
    return Response.json({ error: "Invalid model diagnostic request" }, { status: 400 });
  const { id } = await context.params;
  const connection = await getProviderConnectionById(id);
  if (!connection) return Response.json({ error: "Connection not found" }, { status: 404 });
  if (connection.provider !== "codex")
    return Response.json(
      { error: "Live model diagnostics are supported for Codex accounts" },
      { status: 400 }
    );
  if (connection.isActive === false)
    return Response.json({ error: "Connection is inactive" }, { status: 409 });
  const models = [
    ...new Set(
      (parsed.data.models || getModelsByProviderId("codex").map((m) => m.id)).map((model) =>
        normalizeAccountModel("codex", model)
      )
    ),
  ].slice(0, 32);
  const diagnostics: Array<
    ReturnType<typeof publicModelSupport> | { model: string; status: "unknown"; reason: string }
  > = [];
  for (const model of models) {
    if (request.signal.aborted) break;
    const result = await diagnoseAccountModel("codex", connection, model, {
      refresh: parsed.data.refresh,
      signal: request.signal,
    });
    diagnostics.push(
      result
        ? publicModelSupport(result)
        : { model, status: "unknown", reason: "probe_busy_or_no_credentials" }
    );
  }
  return Response.json({ connectionId: id, provider: "codex", diagnostics });
}
