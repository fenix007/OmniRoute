import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-enrichment-bounds-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../src/lib/db/core.ts");
const completed = await import("../../src/lib/usage/completedRequestDetails.ts");
const artifacts = await import("../../src/lib/usage/callLogArtifacts.ts");
const { MAX_PREVIEW_STRING } = await import("../../src/lib/usage/usageHistory/helpers.ts");

test.after(() => {
  completed.clearCompletedDetails();
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

for (const withPipeline of [false, true]) {
  test(`completed detail enrichment bounds ${withPipeline ? "pipeline" : "legacy response"} payloads`, async () => {
    const id = `enriched-${withPipeline}`;
    const response = { choices: [{ message: { content: "x".repeat(256 * 1024) } }] };
    const artifactPath = `${id}.json`;
    fs.mkdirSync(artifacts.CALL_LOGS_DIR!, { recursive: true });
    fs.writeFileSync(
      path.join(artifacts.CALL_LOGS_DIR!, artifactPath),
      JSON.stringify({
        responseBody: withPipeline ? null : response,
        ...(withPipeline
          ? { pipeline: { providerResponse: response, clientResponse: response } }
          : {}),
      })
    );
    core
      .getDbInstance()
      .prepare(
        "INSERT INTO call_logs (id, model, connection_id, timestamp, artifact_relpath) VALUES (?, ?, ?, ?, ?)"
      )
      .run(id, id, "account", new Date().toISOString(), artifactPath);
    const detail = {
      id,
      model: id,
      provider: "codex",
      connectionId: "account",
      startedAt: Date.now(),
    };
    completed.storeCompletedDetail(detail);
    completed.maybeEnrichCompletedDetail(detail, "account");
    await new Promise((resolve) => setImmediate(resolve));
    const retained = completed.getCompletedDetails().get(id)!;
    for (const payload of [retained.providerResponse, retained.clientResponse]) {
      const content = (payload as typeof response).choices[0].message.content;
      assert.equal(content.length, MAX_PREVIEW_STRING + 3);
      assert.ok(content.endsWith("..."));
    }
    const persisted = JSON.parse(
      fs.readFileSync(path.join(artifacts.CALL_LOGS_DIR!, artifactPath), "utf8")
    );
    assert.equal(
      (withPipeline ? persisted.pipeline.providerResponse : persisted.responseBody).choices[0]
        .message.content.length,
      256 * 1024
    );
  });
}
