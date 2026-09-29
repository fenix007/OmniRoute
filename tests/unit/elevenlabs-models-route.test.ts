import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-elevenlabs-models-"));
process.env.DATA_DIR = dataDir;

const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
const { GET } = await import("../../src/app/api/providers/[id]/models/route.ts");

test.after(() => {
  resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("provider models API exposes ElevenLabs v4 and v4 Turbo alongside legacy TTS", async () => {
  const connection = await createProviderConnection({
    provider: "elevenlabs",
    authType: "apikey",
    name: "ElevenLabs test connection",
    apiKey: "test-elevenlabs-key",
    isActive: true,
    testStatus: "active",
  });
  const response = await GET(
    new Request(`http://localhost/api/providers/${connection.id}/models`),
    { params: { id: connection.id } }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.provider, "elevenlabs");
  assert.equal(body.source, "local_catalog");
  assert.deepEqual(
    body.models.map((model: { id: string }) => model.id),
    ["eleven_v4", "eleven_v4_turbo", "eleven_multilingual_v2", "eleven_turbo_v2_5"]
  );
});
