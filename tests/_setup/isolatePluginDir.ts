import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

/** Keep real plugin install/upgrade tests out of the user's plugin directory. */
export function isolatePluginInstallDir(manager: object): string {
  // The singleton has no public directory override. Limit this fixture override
  // to its existing storage field so a rename cannot silently bypass isolation.
  assert.ok(Object.hasOwn(manager, "pluginDir"));
  const dir = mkdtempSync(join(tmpdir(), "omniroute-plugin-installs-"));
  Reflect.set(manager, "pluginDir", dir);
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
