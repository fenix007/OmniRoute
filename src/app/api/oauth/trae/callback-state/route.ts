import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { issueTraeCallbackState } from "@/lib/oauth/traeCallbackState";

export async function POST(request: Request) {
  const authResponse = await requireManagementAuth(request);
  if (authResponse) return authResponse;

  const { state, expiresAt } = issueTraeCallbackState();
  return NextResponse.json(
    { state, expiresAt: new Date(expiresAt).toISOString() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
