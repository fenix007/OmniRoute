import { HTTP_STATUS } from "../config/constants.ts";

// Model access patterns — the account does not have access to the requested model
// but a different account (e.g. PRO vs free tier) may support it.
export const MODEL_ACCESS_DENIED_PATTERNS = [
  /\binvalid model\b/i,
  /\bmodel.*not.*(?:available|found|supported|accessible)\b/i,
  /\bmodel.*(?:does not exist|doesn't exist)\b/i,
  /\baccess.*denied.*model\b/i,
  /\bmodel.*access.*denied\b/i,
  /\bplease select a different model\b/i,
  // "...access to the requested model" / "model ... access" — bounded lookahead
  // (no nested quantifiers) so it stays ReDoS-safe while requiring BOTH an
  // access/permission word and "model" so a pure auth error never matches.
  /\b(?:access|permission)[\s\S]{0,60}?\bmodel\b/i,
  /\bmodel[\s\S]{0,60}?\b(?:access|permission)\b/i,
];

// Pure credential/authentication failures — the key or token itself is bad, which
// is NOT a model-availability problem. Some providers phrase these as a 400 that
// also mentions the model (e.g. "invalid api key for model X"), which would
// otherwise trip MODEL_ACCESS_DENIED_PATTERNS above and trigger combo fallback
// across every target, masking the real "fix your credential" error. When the
// text clearly indicates a bad credential, the regex-based model-access detection
// is suppressed (structured codes/types like model_not_found are unaffected).
export const AUTH_CREDENTIAL_ERROR_PATTERNS = [
  /\b(?:invalid|incorrect|expired|missing|revoked)\s+api[\s_-]?key\b/i,
  /\bapi[\s_-]?key\s+(?:is\s+)?(?:invalid|incorrect|expired|missing|revoked|not\s+valid)\b/i,
  /\bauthentication\s+(?:failed|error|required)\b/i,
  /\b(?:invalid|expired|missing|revoked)\s+(?:token|credentials?|bearer)\b/i,
  /\bunauthorized\b/i,
  /\bnot\s+authenticated\b/i,
];

// #10460: strict subset of MODEL_ACCESS_DENIED_PATTERNS that is unambiguously
// PROVIDER-wide — the model does not exist / is not served by this provider at all, so
// no account of that provider could serve it (e.g. "The requested model is not
// supported", "model not found"). Deliberately EXCLUDES the "access"/"permission"
// patterns from MODEL_ACCESS_DENIED_PATTERNS (e.g. "does not have permission to access
// this model", "access denied ... model"): those commonly indicate an ACCOUNT-scoped
// entitlement gap (e.g. PRO vs free tier) where a *different* account of the same
// provider may still have access, so they must keep rotating through the normal
// account-cooldown path — not be treated as provider-wide unsupported.
const PROVIDER_MODEL_UNSUPPORTED_PATTERNS = [
  /\binvalid model\b/i,
  /\bmodel.*not.*(?:available|found|supported|accessible)\b/i,
  /\bmodel.*(?:does not exist|doesn't exist)\b/i,
  /\bmodel\b[\s\S]{0,80}?\b(?:does\s+not\s+support|doesn't\s+support|unsupported)\b/i,
  /\b(?:does\s+not\s+support|doesn't\s+support|unsupported)\b[\s\S]{0,80}?\bmodel\b/i,
  /\bunsupported\s+model\b/i,
  /\bplease select a different model\b/i,
];

// "Not supported with THIS kind of account": the model exists, but the account's plan cannot
// use it — e.g. Codex "The 'gpt-5.6-sol' model is not supported when using Codex with a
// ChatGPT account." It matches the provider-wide patterns above, yet another account of the
// same provider serves the model, so it must rotate instead of failing the request.
const ACCOUNT_SCOPED_MODEL_UNSUPPORTED_PATTERNS = [
  /\bnot\s+supported\s+when\s+using\b[\s\S]{0,60}?\bwith\s+(?:a|an|your)\b[\s\S]{0,40}?\baccount\b/i,
];

/**
 * Is this 400 an account-scoped "model not supported" answer (the account's plan lacks the
 * model, other accounts may have it)? Bad-credential texts are never treated as such.
 */
export function isAccountScopedModelUnsupported400(status: number, errorText: string): boolean {
  if (status !== HTTP_STATUS.BAD_REQUEST) return false;
  if (AUTH_CREDENTIAL_ERROR_PATTERNS.some((p) => p.test(errorText))) return false;
  return ACCOUNT_SCOPED_MODEL_UNSUPPORTED_PATTERNS.some((p) => p.test(errorText));
}

/** Only the explicit model-or-account access wording, never a generic route 404. */
export function isAccountScopedModelUnavailable404(status: number, errorText: string): boolean {
  if (status !== HTTP_STATUS.NOT_FOUND) return false;
  if (AUTH_CREDENTIAL_ERROR_PATTERNS.some((pattern) => pattern.test(errorText))) return false;
  return /\bmodel\b[^\r\n]{1,200}\bdoes not exist or you do not have access to it\b/i.test(
    errorText
  );
}

/**
 * #10460: is this 400 an unambiguous, PROVIDER-wide "model not supported" response —
 * i.e. would retrying a *different account* of the same provider also fail for the
 * same reason? Reuses AUTH_CREDENTIAL_ERROR_PATTERNS (the same bad-credential
 * exclusion `checkFallbackError`'s 400 branch applies) so a message like "invalid api
 * key for model X" is never misclassified as model-wide. Also excludes the broader,
 * ambiguous MODEL_ACCESS_DENIED_PATTERNS access/permission phrasing — those can be
 * account-scoped entitlement gaps, not a provider-wide unsupported model — so account
 * rotation for those keeps working normally via the regular cooldown path.
 *
 * Callers that want "should combo keep trying other targets" (not "should this
 * specific account keep rotating") should use MODEL_ACCESS_DENIED_PATTERNS /
 * isModelScoped400() instead — this helper is deliberately narrower.
 */
export function isProviderModelUnsupported400(status: number, errorText: string): boolean {
  if (status !== HTTP_STATUS.BAD_REQUEST) return false;
  if (AUTH_CREDENTIAL_ERROR_PATTERNS.some((p) => p.test(errorText))) return false;
  if (isAccountScopedModelUnsupported400(status, errorText)) return false;
  return PROVIDER_MODEL_UNSUPPORTED_PATTERNS.some((p) => p.test(errorText));
}
