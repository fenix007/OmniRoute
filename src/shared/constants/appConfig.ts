import pkg from "../../../package.json" with { type: "json" };

export function formatAppVersion(baseVersion: string, forkVersion?: string): string {
  const normalizedForkVersion = forkVersion?.trim().replace(/^v/, "");
  if (!normalizedForkVersion || normalizedForkVersion === baseVersion) {
    return `v${baseVersion}`;
  }

  const forkSuffix = normalizedForkVersion.startsWith(`${baseVersion}-`)
    ? normalizedForkVersion.slice(baseVersion.length + 1)
    : normalizedForkVersion;

  return `v${baseVersion} · ${forkSuffix}`;
}

export const APP_CONFIG = {
  name: "OmniRoute",
  description: "AI Gateway for Multi-Provider LLMs",
  version: pkg.version,
  versionLabel: formatAppVersion(pkg.version, process.env.NEXT_PUBLIC_OMNIROUTE_FORK_VERSION),
};

export const THEME_CONFIG = {
  storageKey: "theme",
  defaultTheme: "system",
};
