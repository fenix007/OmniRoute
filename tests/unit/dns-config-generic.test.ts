/**
 * Unit tests: parameterized DNS helpers (addDNSEntries / removeDNSEntries).
 *
 * Privileged commands and hosts-file reads are replaced through the explicit
 * dnsConfigInternals test seam. No test in this file reads or writes the real
 * hosts file, invokes sudo, or starts an elevated PowerShell process.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dnsModule = await import("../../src/mitm/dns/dnsConfig.ts");
const {
  addDNSEntries,
  removeDNSEntries,
  addDNSEntry,
  removeDNSEntry,
  checkDNSEntry,
  dnsConfigInternals,
} = dnsModule;
const { ALL_TARGETS } = await import("../../src/mitm/targets/index.ts");

interface ExecCall {
  command: string;
  args: string[];
  sudoPassword: string;
  stdin?: string;
}

const execCalls: ExecCall[] = [];
const powershellCalls: string[] = [];
let hostsContent = "";

const originalReadHostsFile = dnsConfigInternals.readHostsFile;
const originalExecFileWithPassword = dnsConfigInternals.execFileWithPassword;
const originalRunElevatedPowerShell = dnsConfigInternals.runElevatedPowerShell;

test.beforeEach(() => {
  execCalls.length = 0;
  powershellCalls.length = 0;
  hostsContent = "";
  dnsConfigInternals.readHostsFile = () => hostsContent;
  dnsConfigInternals.execFileWithPassword = async (
    command: string,
    args: string[],
    sudoPassword: string,
    stdin?: string
  ) => {
    execCalls.push({ command, args, sudoPassword, stdin });
  };
  dnsConfigInternals.runElevatedPowerShell = async (script: string) => {
    powershellCalls.push(script);
  };
});

test.after(() => {
  dnsConfigInternals.readHostsFile = originalReadHostsFile;
  dnsConfigInternals.execFileWithPassword = originalExecFileWithPassword;
  dnsConfigInternals.runElevatedPowerShell = originalRunElevatedPowerShell;
});

function privilegedCallCount(): number {
  return execCalls.length + powershellCalls.length;
}

function assertAddedHosts(hosts: string[]) {
  if (process.platform === "win32") {
    assert.equal(powershellCalls.length, 1);
    for (const host of hosts) {
      assert.match(powershellCalls[0], new RegExp(host.replaceAll(".", "\\.")));
    }
    return;
  }

  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].command, "sudo");
  assert.deepEqual(execCalls[0].args.slice(0, 3), ["-S", "tee", "-a"]);
  for (const host of hosts) {
    const escapedHost = host.replaceAll(".", "\\.");
    assert.match(execCalls[0].stdin || "", new RegExp(`127\\.0\\.0\\.1 ${escapedHost}`));
    assert.match(execCalls[0].stdin || "", new RegExp(`::1 ${escapedHost}`));
  }
}

test("checkDNSEntry returns a boolean without reading the system hosts file", () => {
  assert.equal(typeof checkDNSEntry(), "boolean");
});

test("addDNSEntries and removeDNSEntries are no-ops for empty host lists", async () => {
  await addDNSEntries([], "unused-password");
  await removeDNSEntries([], "unused-password");
  assert.equal(privilegedCallCount(), 0);
});

test("addDNSEntry resolves agent-specific hosts from ALL_TARGETS", async () => {
  const cursorHosts = ALL_TARGETS.find((target) => target.id === "cursor")?.hosts;
  assert.ok(cursorHosts?.includes("api2.cursor.sh"));

  await addDNSEntry("fake-sudo", "cursor");

  assertAddedHosts(cursorHosts);
});

test("addDNSEntry defaults to Antigravity hosts", async () => {
  await addDNSEntry("fake-sudo");

  assertAddedHosts(["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"]);
});

test("addDNSEntry uses Antigravity hosts for an unknown agent", async () => {
  await addDNSEntry("fake-sudo", "__nonexistent_agent__");

  assertAddedHosts(["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"]);
});

test("removeDNSEntry resolves agent-specific hosts without invoking real commands", async () => {
  const copilotHosts = ALL_TARGETS.find((target) => target.id === "copilot")?.hosts;
  assert.ok(copilotHosts?.length);
  hostsContent = copilotHosts.flatMap((host) => [`127.0.0.1 ${host}`, `::1 ${host}`]).join("\n");

  await removeDNSEntry("fake-sudo", "copilot");

  if (process.platform === "win32") {
    assert.equal(powershellCalls.length, 1);
    for (const host of copilotHosts) {
      assert.match(powershellCalls[0], new RegExp(host.replaceAll(".", "\\.")));
    }
  } else {
    assert.equal(execCalls.length, copilotHosts.length);
    for (const [index, host] of copilotHosts.entries()) {
      assert.equal(execCalls[index].command, "sudo");
      assert.equal(execCalls[index].args.at(-1), host);
      assert.equal(execCalls[index].sudoPassword, "fake-sudo");
    }
  }
});

test("addDNSEntries skips entries already present", async () => {
  hostsContent = "127.0.0.1 localhost\n::1 localhost\n";

  await addDNSEntries(["localhost"], "fake-sudo");

  assert.equal(privilegedCallCount(), 0);
});

test("removeDNSEntries skips hosts that are absent", async () => {
  await removeDNSEntries(["absent.invalid"], "fake-sudo");

  assert.equal(privilegedCallCount(), 0);
});

test("addDNSEntries passes host data through stdin and uses argv for the target file", async () => {
  await addDNSEntries(["example.invalid"], "fake-sudo");

  if (process.platform !== "win32") {
    assert.deepEqual(execCalls[0].args, ["-S", "tee", "-a", "/etc/hosts"]);
    assert.equal(execCalls[0].stdin, "127.0.0.1 example.invalid\n::1 example.invalid\n");
  }
});

test("removeDNSEntries passes the hosts file and hostname as argv", async () => {
  hostsContent = "127.0.0.1 example.invalid\n::1 example.invalid\n";

  await removeDNSEntries(["example.invalid"], "fake-sudo");

  if (process.platform !== "win32") {
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0].args[0], "-S");
    assert.equal(execCalls[0].args[1], process.execPath);
    assert.equal(execCalls[0].args[2], "-e");
    assert.equal(execCalls[0].args.at(-2), "/etc/hosts");
    assert.equal(execCalls[0].args.at(-1), "example.invalid");
  }
});

test("privileged DNS calls remain array-based in the implementation", () => {
  const srcPath = new URL("../../src/mitm/dns/dnsConfig.ts", import.meta.url).pathname;
  const src = fs.readFileSync(srcPath, "utf8");
  assert.ok(src.includes('["-S", "tee", "-a", HOSTS_FILE]'));
  assert.ok(src.includes("REMOVE_HOSTS_ENTRY_SCRIPT, HOSTS_FILE, hostname"));
});
