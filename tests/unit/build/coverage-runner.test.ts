import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const { scripts } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

test("coverage runner retains coverage from native, dashboard and serial collectors", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "omniroute-coverage-runner-"));
  try {
    const parentCoverage = path.join(fixture, "parent-coverage");
    mkdirSync(parentCoverage);
    const parentMarker = path.join(parentCoverage, "sentinel");
    writeFileSync(parentMarker, "parent coverage must be preserved");
    const stages = ["native", "dashboard", "serial"];
    const commands = scripts["test:coverage:runner"].split(" && ");
    assert.equal(commands.length, stages.length);
    const fixtureCommands = commands.map((command: string, index: number) => {
      if (command === "npm run test:unit:serial") command = scripts["test:unit:serial"];
      // Keep the actual collector wrappers, replacing only the expensive test
      // processes. A nested collector must not erase earlier V8 coverage files.
      assert.match(command, /\bnode --max-old-space-size=\d+ /);
      const name = stages[index];
      writeFileSync(
        path.join(fixture, `${name}.cjs`),
        `function covered${name}() { return 1; }\ncovered${name}();\n`
      );
      return command.replace(/\bnode --max-old-space-size=\d+ .+$/, `node ${name}.cjs`);
    });
    writeFileSync(
      path.join(fixture, "runner.cjs"),
      `require("node:child_process").execSync(${JSON.stringify(fixtureCommands.join(" && "))}, { stdio: "pipe" });\n`
    );
    execFileSync(
      process.execPath,
      [
        path.join(root, "node_modules/c8/bin/c8.js"),
        "--output-dir=coverage",
        "--temp-directory=coverage/tmp",
        "--reporter=json-summary",
        "node",
        "runner.cjs",
      ],
      {
        cwd: fixture,
        env: {
          ...process.env,
          NODE_V8_COVERAGE: parentCoverage,
          PATH: `${path.join(root, "node_modules/.bin")}${path.delimiter}${process.env.PATH}`,
        },
        timeout: 30_000,
        stdio: "pipe",
      }
    );
    assert.equal(readFileSync(parentMarker, "utf8"), "parent coverage must be preserved");
    const summary = JSON.parse(
      readFileSync(path.join(fixture, "coverage/coverage-summary.json"), "utf8")
    );
    for (const stage of stages) {
      const entry = Object.entries(summary).find(
        ([file]) => path.basename(file) === `${stage}.cjs`
      );
      assert.ok(entry, `${stage} collector coverage must survive subsequent collectors`);
      assert.equal((entry[1] as { functions: { pct: number } }).functions.pct, 100);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
