export function resolveCodexAccountId(
  accessToken: unknown,
  providerSpecificData?: Record<string, unknown> | null
): string | null {
  const validAccountId = (value: unknown): string | null =>
    typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : null;
  if (typeof accessToken === "string") {
    const parts = accessToken.split(".");
    if (parts.length === 3 && parts[1].length <= 16384) {
      try {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        const accountId = validAccountId(
          payload?.["https://api.openai.com/auth"]?.chatgpt_account_id
        );
        if (accountId) return accountId;
      } catch {}
    }
  }
  return (
    validAccountId(providerSpecificData?.workspaceId) ||
    validAccountId(providerSpecificData?.chatgptAccountId) ||
    validAccountId(providerSpecificData?.accountId)
  );
}
