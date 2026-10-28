import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const COMPONENT_DIR = join(ROOT, "src/app/(dashboard)/dashboard/providers/[id]/components");
const COMPONENTS = [
  "ConnectionRow.tsx",
  "ConnectionsHeaderToolbar.tsx",
  "ConnectionsListPanel.tsx",
];

function loadProviders(locale: string): Record<string, unknown> {
  const messages = JSON.parse(readFileSync(join(ROOT, `src/i18n/messages/${locale}.json`), "utf8"));
  return messages.providers;
}

function usedProviderKeys(): string[] {
  const keys = new Set<string>();
  for (const file of COMPONENTS) {
    const source = readFileSync(join(COMPONENT_DIR, file), "utf8");
    for (const match of source.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/g)) keys.add(match[1]);
    for (const match of source.matchAll(/provider(?:Count)?Text\(\s*t,\s*"([A-Za-z0-9_]+)"/g)) {
      keys.add(match[1]);
    }
  }
  return [...keys].sort();
}

// A value like "Toggle On Short" for key "toggleOnShort" is an auto-generated placeholder.
// English labels may legitimately spell out their key ("Provider Proxy"), so in English
// only keys with a structural suffix that never belongs to the visible text are checked.
function isKeyPlaceholder(locale: string, key: string, value: string): boolean {
  const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!value.includes(" ") || normalize(value) !== normalize(key)) return false;
  return locale !== "en" || /(Short|Title|Label|Hint|Badge|Placeholder|Description)$/.test(key);
}

for (const locale of ["en", "ru"]) {
  test(`${locale} provider connection labels are real translations`, () => {
    const providers = loadProviders(locale);
    const broken = usedProviderKeys().filter((key) => {
      const value = providers[key];
      if (typeof value !== "string") return false;
      return value.startsWith("__MISSING__") || isKeyPlaceholder(locale, key, value);
    });
    assert.deepEqual(broken, []);
  });
}
