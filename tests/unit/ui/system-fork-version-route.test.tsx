// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/shared/utils/apiAuth", () => ({ isAuthenticated: vi.fn() }));
vi.mock("@/lib/system/versionCheck", () => ({
  resolveLatestVersion: vi.fn(),
  isNewer: vi.fn(() => true),
}));
vi.mock("@/lib/system/autoUpdate", () => ({
  ensureGitTagExists: vi.fn(),
  getAutoUpdateConfig: vi.fn(() => ({ mode: "source" })),
  launchAutoUpdate: vi.fn(),
  validateAutoUpdateRuntime: vi.fn(async () => ({ supported: false })),
  PROJECT_ROOT: "/unused",
}));
vi.mock("@/lib/system/globalPackagePath", () => ({ resolveGlobalOmniroutePath: vi.fn() }));
vi.mock("@/lib/services/installers/utils", () => ({
  buildNpmExecOptions: vi.fn(),
  SERVICE_VERSION_PATTERN: /^\d+\.\d+\.\d+$/,
}));

import { GET, POST } from "../../../src/app/api/system/version/route";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { resolveLatestVersion } from "@/lib/system/versionCheck";
import {
  getAutoUpdateConfig,
  launchAutoUpdate,
  validateAutoUpdateRuntime,
} from "@/lib/system/autoUpdate";

const req = () => new NextRequest("http://localhost/api/system/version");

describe("fork version route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_OMNIROUTE_FORK_VERSION", "fork · sha-1111111");
    vi.mocked(isAuthenticated).mockResolvedValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ workflow_runs: [] }))
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("requires authentication before checking or updating", async () => {
    vi.mocked(isAuthenticated).mockResolvedValue(false);
    expect((await GET(req())).status).toBe(401);
    expect((await POST(req())).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveLatestVersion).not.toHaveBeenCalled();
  });

  it("fork GET bypasses npm, upstream news and updater runtime checks", async () => {
    const response = await GET(req());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      channel: "fork",
      latest: "unavailable",
      updateAvailable: false,
      autoUpdateSupported: false,
      news: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(resolveLatestVersion).not.toHaveBeenCalled();
    expect(getAutoUpdateConfig).not.toHaveBeenCalled();
    expect(validateAutoUpdateRuntime).not.toHaveBeenCalled();
  });

  it("fork POST cannot invoke the upstream updater", async () => {
    const response = await POST(req());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, channel: "fork" });
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveLatestVersion).not.toHaveBeenCalled();
    expect(launchAutoUpdate).not.toHaveBeenCalled();
    expect(getAutoUpdateConfig).not.toHaveBeenCalled();
  });

  it("ordinary builds preserve their existing upstream lookup", async () => {
    vi.stubEnv("NEXT_PUBLIC_OMNIROUTE_FORK_VERSION", "");
    vi.mocked(resolveLatestVersion).mockResolvedValue("3.8.50");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ active: false }))
    );
    const response = await GET(req());
    expect(await response.json()).toMatchObject({ latest: "3.8.50", channel: "source" });
    expect(resolveLatestVersion).toHaveBeenCalledOnce();
    expect(validateAutoUpdateRuntime).toHaveBeenCalledOnce();
  });
});
