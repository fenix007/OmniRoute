import test from "node:test";
import assert from "node:assert/strict";
import {
  translateUsageOrFallback,
  type UsageTranslator,
} from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/i18nFallback";

test("quota labels fall back when an existing translation is a missing sentinel", () => {
  const t: UsageTranslator = (_, values) => `__MISSING__:Token expires in ${values?.time}`;
  t.has = () => true;
  assert.equal(
    translateUsageOrFallback(t, "tokenExpiresIn", "Token expires in 5m", { time: "5m" }),
    "Token expires in 5m"
  );
  assert.equal(
    translateUsageOrFallback(() => "__MISSING__:Token expired", "tokenExpired", "Token expired"),
    "Token expired"
  );
});

test("quota labels preserve valid localized translations and interpolation", () => {
  const t: UsageTranslator = (_, values) => `Токен истекает через ${values?.time}`;
  t.has = () => true;
  assert.equal(
    translateUsageOrFallback(t, "tokenExpiresIn", "Token expires in 5m", { time: "5m" }),
    "Токен истекает через 5m"
  );
});

test("quota labels retain fallbacks for unavailable translations", () => {
  for (const translation of ["", "tokenExpired", "usage.tokenExpired"]) {
    assert.equal(
      translateUsageOrFallback(() => translation, "tokenExpired", "Token expired"),
      "Token expired"
    );
  }
  const t: UsageTranslator = () => {
    throw new Error("missing translation");
  };
  assert.equal(translateUsageOrFallback(t, "tokenExpired", "Token expired"), "Token expired");
  t.has = () => false;
  assert.equal(translateUsageOrFallback(t, "tokenExpired", "Token expired"), "Token expired");
});
