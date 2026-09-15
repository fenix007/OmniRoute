import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { url as inspectorUrl } from "node:inspector";
import { getHeapStatistics } from "node:v8";
import {
  captureRuntimeDiagnostics,
  diagnosticConfig,
  sanitizeCpuProfile,
} from "../../scripts/dev/runtime-diagnostics.mjs";

test("diagnostics are opt-in with bounded, strictly numeric timing", () => {
  assert.equal(diagnosticConfig({}), null);
  assert.equal(diagnosticConfig({ OMNIROUTE_RUNTIME_DIAGNOSTICS: "true" }), null);
  assert.deepEqual(diagnosticConfig({ OMNIROUTE_RUNTIME_DIAGNOSTICS: "1" }), {
    delaySeconds: 120,
    durationSeconds: 180,
  });
  for (const value of ["0", "301", "1.5", "-1", "Infinity", "1;evil"]) {
    assert.throws(() =>
      diagnosticConfig({
        OMNIROUTE_RUNTIME_DIAGNOSTICS: "1",
        OMNIROUTE_DIAGNOSTICS_DURATION_SECONDS: value,
      })
    );
  }
  assert.throws(() =>
    diagnosticConfig({
      OMNIROUTE_RUNTIME_DIAGNOSTICS: "1",
      OMNIROUTE_DIAGNOSTICS_DELAY_SECONDS: "3601",
    })
  );
});

test("profile serialization drops URL credentials in queries and unneeded fields", () => {
  const profile = sanitizeCpuProfile({
    startTime: 1,
    endTime: 2,
    samples: [1],
    timeDeltas: [1],
    unneeded: "secret",
    nodes: [
      {
        id: 1,
        hitCount: 1,
        arbitrary: "secret",
        callFrame: {
          functionName: "worker",
          scriptId: "1",
          url: "file:///app/worker.js?token=secret#secret",
          lineNumber: 2,
          columnNumber: 3,
        },
      },
    ],
  });
  assert.equal(profile.nodes[0].callFrame.url, "file:///app/worker.js");
  assert.equal(JSON.stringify(profile).includes("secret"), false);
});

test("capture measures this process and leaves no network inspector listener", async () => {
  const beforeInspector = inspectorUrl();
  const keepAlive = setInterval(() => {}, 50);
  let directory;
  try {
    directory = await captureRuntimeDiagnostics(1);
    const telemetry = JSON.parse(await readFile(`${directory}/telemetry.json`, "utf8"));
    const profile = JSON.parse(await readFile(`${directory}/cpu.cpuprofile`, "utf8"));
    assert.equal(telemetry.pid, process.pid);
    assert.ok(telemetry.samples.length >= 2);
    for (const sample of telemetry.samples) {
      assert.equal(sample.heap.limitBytes, getHeapStatistics().heap_size_limit);
      assert.ok(sample.memory.rss > 0);
      assert.ok(Number.isFinite(sample.delayMs.max));
      assert.ok(sample.eventLoop.utilization >= 0);
    }
    assert.ok(profile.nodes.length > 0);
    assert.ok(profile.samples.length > 0);
    assert.ok(profile.endTime > profile.startTime);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(`${directory}/telemetry.json`)).mode & 0o777, 0o600);
    assert.equal((await stat(`${directory}/cpu.cpuprofile`)).mode & 0o777, 0o600);
    assert.equal(inspectorUrl(), beforeInspector);
  } finally {
    clearInterval(keepAlive);
    if (directory) await rm(directory, { recursive: true });
  }
});

test("scheduled diagnostics do not keep an otherwise finished server alive", () => {
  const moduleUrl = new URL("../../scripts/dev/runtime-diagnostics.mjs", import.meta.url).href;
  const code = `import { runRuntimeDiagnostics } from ${JSON.stringify(moduleUrl)};
    void runRuntimeDiagnostics({ OMNIROUTE_RUNTIME_DIAGNOSTICS: "1",
      OMNIROUTE_DIAGNOSTICS_DELAY_SECONDS: "60" });`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    timeout: 3000,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});
