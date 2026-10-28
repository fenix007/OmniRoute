import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Messages = { [key: string]: string | Messages };

function load(locale: string): Messages {
  return JSON.parse(readFileSync(join(process.cwd(), `src/i18n/messages/${locale}.json`), "utf8"));
}

function leaves(messages: Messages, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [nested, text] of leaves(value, path)) out.set(nested, text);
  }
  return out;
}

test("ru.json translates every en.json key without __MISSING__ placeholders", () => {
  const en = leaves(load("en"));
  const ru = leaves(load("ru"));
  const absent = [...en.keys()].filter((key) => !ru.has(key));
  const placeholders = [...ru].filter(([, text]) => text.startsWith("__MISSING__:")).map(([key]) => key);
  assert.deepEqual(absent, []);
  assert.deepEqual(placeholders, []);
});
