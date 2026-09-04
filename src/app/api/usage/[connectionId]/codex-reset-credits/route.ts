import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { CodexResetCreditError, listCodexResetCredits } from "@/lib/usage/codexResetCredits";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

const ConnectionIdSchema = z.string().trim().min(1).max(256);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const parsed = ConnectionIdSchema.safeParse((await params).connectionId);
  if (!parsed.success) {
    return NextResponse.json(
      { code: "invalid_connection_id", error: "Invalid connectionId." },
      { status: 400 }
    );
  }

  try {
    return NextResponse.json(await listCodexResetCredits(parsed.data));
  } catch (error) {
    const status = error instanceof CodexResetCreditError ? error.status : 500;
    const code =
      error instanceof CodexResetCreditError ? error.code : "codex_reset_credit_list_failed";
    const message =
      error instanceof CodexResetCreditError
        ? sanitizeErrorMessage(error.message) || "Codex reset-credit request failed."
        : "Codex reset-credit request failed.";

    console.error("[API] GET /api/usage/[connectionId]/codex-reset-credits failed", {
      status,
      code,
    });

    return NextResponse.json({ code, error: message }, { status });
  }
}
