import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { CodexResetCreditError, consumeCodexResetCredit } from "@/lib/usage/codexResetCredits";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

const CodexResetCreditBodySchema = z
  .object({
    connectionId: z.string().trim().min(1).max(256),
    idempotencyKey: z.string().trim().min(1).max(256),
    expectedCreditExpiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const raw = await request.json().catch(() => ({}));
    const parsed = CodexResetCreditBodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, code: "invalid_request_body", error: "Invalid request body." },
        { status: 400 }
      );
    }

    const result = await consumeCodexResetCredit(
      parsed.data.connectionId,
      parsed.data.idempotencyKey,
      parsed.data.expectedCreditExpiresAt
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const status = error instanceof CodexResetCreditError ? error.status : 500;
    const code = error instanceof CodexResetCreditError ? error.code : "codex_reset_credit_failed";
    const message =
      error instanceof CodexResetCreditError
        ? sanitizeErrorMessage(error.message) || "Failed to redeem Codex reset credit."
        : "Failed to redeem Codex reset credit.";
    console.error("[API] POST /api/usage/codex-reset-credit failed", { status, code });
    return NextResponse.json({ ok: false, code, error: message }, { status });
  }
}
