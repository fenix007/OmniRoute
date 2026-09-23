import test from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
  CODEX_OAUTH_CLIENT_ID: "app_EMoamEEZ73f0CkXaXp7hrann",
});

const { codex, deriveCodexWorkspaceInfo } = await import("../../src/lib/oauth/providers/codex.ts");
const { refreshCodexToken } = await import("../../open-sse/services/tokenRefresh.ts");

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function base64Url(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

/** Build an unsigned id_token carrying the OpenAI auth claim. */
function makeIdToken(auth: Record<string, unknown>, email = "someone@example.com"): string {
  const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ email, "https://api.openai.com/auth": auth }));
  return `${header}.${payload}.`;
}

const PERSONAL_PLUS = {
  chatgpt_account_id: "workspace-personal",
  chatgpt_plan_type: "plus",
  chatgpt_user_id: "user-1",
  chatgpt_subscription_active_start: "2026-08-19T07:23:26Z",
  chatgpt_subscription_active_until: "2026-09-19T07:23:26Z",
  chatgpt_subscription_last_checked: "2026-09-16T06:00:00Z",
  organizations: [{ id: "org-1", is_default: true, role: "owner", title: "Personal" }],
};

test("deriveCodexWorkspaceInfo reads the plan tier out of an id_token", () => {
  const info = deriveCodexWorkspaceInfo(makeIdToken(PERSONAL_PLUS));

  assert.equal(info?.workspacePlanType, "plus");
  assert.equal(info?.workspaceId, "workspace-personal");
  assert.equal(info?.chatgptUserId, "user-1");
  assert.equal(info?.subscriptionActiveUntil, "2026-09-19T07:23:26.000Z");
});

test("deriveCodexWorkspaceInfo returns null when the token carries no auth claim", () => {
  const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ email: "someone@example.com" }));

  assert.equal(deriveCodexWorkspaceInfo(`${header}.${payload}.`), null);
  assert.equal(deriveCodexWorkspaceInfo("not-a-jwt"), null);
  assert.equal(deriveCodexWorkspaceInfo(null), null);
});

test("deriveCodexWorkspaceInfo keeps the granted account despite team membership", () => {
  const info = deriveCodexWorkspaceInfo(
    makeIdToken({
      chatgpt_account_id: "workspace-personal",
      chatgpt_plan_type: "free",
      chatgpt_user_id: "user-2",
      organizations: [
        { id: "org-personal", is_default: true, role: "owner", title: "Personal" },
        { id: "org-team", is_default: false, role: "member", title: "Acme Workspace" },
      ],
    })
  );

  assert.equal(info?.workspacePlanType, "free");
  assert.equal(info?.workspaceId, "workspace-personal");
});

test("mapTokens still derives the persisted workspace record", () => {
  const mapped = codex.mapTokens({
    access_token: "at",
    refresh_token: "rt",
    id_token: makeIdToken(PERSONAL_PLUS, "owner@example.com"),
    expires_in: 864000,
  });

  assert.equal(mapped.email, "owner@example.com");
  assert.deepEqual(mapped.providerSpecificData, {
    workspaceId: "workspace-personal",
    workspacePlanType: "plus",
    subscriptionActiveStart: "2026-08-19T07:23:26.000Z",
    subscriptionActiveUntil: "2026-09-19T07:23:26.000Z",
    subscriptionLastCheckedAt: "2026-09-16T06:00:00.000Z",
    chatgptUserId: "user-1",
    organizations: PERSONAL_PLUS.organizations,
  });
});

test("refreshCodexToken re-derives the plan tier from the refreshed id_token", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        access_token: "new-at",
        refresh_token: "new-rt",
        expires_in: 864000,
        // The subscription lapsed since the account was connected as "plus".
        id_token: makeIdToken({ ...PERSONAL_PLUS, chatgpt_plan_type: "free" }),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  const result = await refreshCodexToken("old-rt", null);

  assert.equal(result.accessToken, "new-at");
  assert.deepEqual(result.providerSpecificDataPatch, {
    workspacePlanType: "free",
    subscriptionActiveStart: "2026-08-19T07:23:26.000Z",
    subscriptionActiveUntil: "2026-09-19T07:23:26.000Z",
    subscriptionLastCheckedAt: "2026-09-16T06:00:00.000Z",
  });
});

test("refreshCodexToken patches only the plan, never the workspace binding", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        access_token: "new-at",
        refresh_token: "new-rt",
        expires_in: 864000,
        id_token: makeIdToken(PERSONAL_PLUS),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  const result = await refreshCodexToken("old-rt", null);

  assert.deepEqual(Object.keys(result.providerSpecificDataPatch), [
    "workspacePlanType",
    "subscriptionActiveStart",
    "subscriptionActiveUntil",
    "subscriptionLastCheckedAt",
  ]);
  assert.equal(result.providerSpecificData, undefined);
});

test("refreshCodexToken omits the patch when the response carries no usable plan", async () => {
  for (const idToken of [undefined, makeIdToken({ ...PERSONAL_PLUS, chatgpt_plan_type: "" })]) {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          access_token: "new-at",
          refresh_token: "new-rt",
          expires_in: 864000,
          ...(idToken ? { id_token: idToken } : {}),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await refreshCodexToken("old-rt", null);

    assert.equal(result.accessToken, "new-at");
    assert.ok(
      !("providerSpecificDataPatch" in result),
      "an unreadable plan must leave the persisted tier untouched"
    );
  }
});
