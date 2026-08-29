import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-dedup-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { findExistingOAuthConnectionMatch, persistOAuthConnection } =
  await import("../../src/lib/oauth/connectionPersistence.ts");

async function resetStorage(): Promise<void> {
  core.resetDbInstance();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      if (fs.existsSync(TEST_DATA_DIR)) {
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
      }
      break;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if ((code === "EBUSY" || code === "EPERM") && attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      } else {
        throw error;
      }
    }
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(resetStorage);
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const personalConnection = {
  id: "personal-a",
  email: "shared@example.com",
  authType: "oauth",
  providerSpecificData: { chatgptUserId: "user-a" },
};

test("Codex OAuth persists personal accounts with the same email separately", async () => {
  const accountA = await persistOAuthConnection("codex", {
    email: "shared@example.com",
    accessToken: "token-account-a",
    refreshToken: "refresh-account-a",
    expiresIn: 3600,
    providerSpecificData: { chatgptUserId: "user-a" },
  });
  const accountB = await persistOAuthConnection("codex", {
    email: "shared@example.com",
    accessToken: "token-account-b",
    refreshToken: "refresh-account-b",
    expiresIn: 3600,
    providerSpecificData: { chatgptUserId: "user-b" },
  });

  const rows = await providersDb.getProviderConnections({ provider: "codex" });
  assert.notEqual(accountB.id, accountA.id);
  assert.equal(rows.length, 2);
  assert.equal(
    rows.find((row: { id: string }) => row.id === accountA.id)?.accessToken,
    "token-account-a"
  );
});

test("Codex OAuth updates the same personal account by chatgptUserId", async () => {
  const first = await persistOAuthConnection("codex", {
    email: "solo@example.com",
    accessToken: "token-first",
    refreshToken: "refresh-first",
    expiresIn: 3600,
    providerSpecificData: { chatgptUserId: "user-solo" },
  });
  const second = await persistOAuthConnection("codex", {
    email: "solo@example.com",
    accessToken: "token-second",
    refreshToken: "refresh-second",
    expiresIn: 3600,
    providerSpecificData: { chatgptUserId: "user-solo" },
  });

  const rows = await providersDb.getProviderConnections({ provider: "codex" });
  assert.equal(second.id, first.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.accessToken, "token-second");
});

test("public ticket mode never matches claims implicitly but honors a bound connectionId", async () => {
  const identity = {
    email: "public@example.com",
    refreshToken: "refresh-public",
    expiresIn: 3600,
    providerSpecificData: { chatgptUserId: "user-public" },
  };
  const existing = await persistOAuthConnection("codex", {
    ...identity,
    accessToken: "token-existing",
  });
  const created = await persistOAuthConnection(
    "codex",
    { ...identity, accessToken: "token-untrusted-claims" },
    undefined,
    { allowImplicitMatch: false }
  );
  const updated = await persistOAuthConnection(
    "codex",
    { ...identity, accessToken: "token-explicit-reauth" },
    existing.id,
    { allowImplicitMatch: false }
  );

  const rows = await providersDb.getProviderConnections({ provider: "codex" });
  assert.notEqual(created.id, existing.id);
  assert.equal(updated.id, existing.id);
  assert.equal(rows.length, 2);
  assert.equal(
    rows.find((row: { id: string }) => row.id === existing.id)?.accessToken,
    "token-explicit-reauth"
  );
});

test("Codex OAuth requires workspaceId agreement when either side has a workspace", () => {
  const teamConnection = {
    ...personalConnection,
    id: "team-a",
    providerSpecificData: { workspaceId: "workspace-a", chatgptUserId: "user-a" },
  };

  assert.equal(
    findExistingOAuthConnectionMatch([teamConnection], "codex", {
      email: "shared@example.com",
      providerSpecificData: { workspaceId: "workspace-b", chatgptUserId: "user-a" },
    }),
    undefined
  );
  assert.equal(
    findExistingOAuthConnectionMatch([teamConnection], "codex", {
      email: "shared@example.com",
      providerSpecificData: { workspaceId: "workspace-a", chatgptUserId: "user-b" },
    })?.id,
    "team-a"
  );
});

test("explicit connectionId remains authoritative for OAuth reauthentication", () => {
  const match = findExistingOAuthConnectionMatch(
    [personalConnection],
    "codex",
    {
      email: "different@example.com",
      providerSpecificData: { chatgptUserId: "different-user" },
    },
    "personal-a"
  );

  assert.equal(match?.id, "personal-a");
});

test("non-Codex OAuth providers retain email-based deduplication", () => {
  const match = findExistingOAuthConnectionMatch([personalConnection], "github", {
    email: "shared@example.com",
  });

  assert.equal(match?.id, "personal-a");
});
