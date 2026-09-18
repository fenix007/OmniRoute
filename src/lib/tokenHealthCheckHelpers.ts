interface TokenHealthConnection {
  tokenExpiresAt?: string | null;
  expiresAt?: string | null;
  provider?: string | null;
  accessToken?: string | null;
  testStatus?: string | null;
  errorCode?: string | number | null;
}

export function getEffectiveTokenExpiryIso(
  conn: TokenHealthConnection | null | undefined
): string | null {
  if (!conn) return null;
  return conn.tokenExpiresAt || conn.expiresAt || null;
}

export function getEffectiveTokenExpiryMs(conn: TokenHealthConnection | null | undefined): number {
  const effectiveExpiry = getEffectiveTokenExpiryIso(conn);
  if (!effectiveExpiry) return 0;
  const expiryMs = new Date(effectiveExpiry).getTime();
  return Number.isFinite(expiryMs) ? expiryMs : 0;
}

export function getCopilotTokenExpiryMs(expiresAt: unknown): number {
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  }
  if (typeof expiresAt === "string" && expiresAt.trim()) {
    const parsed = new Date(expiresAt).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function isGitHubAccessTokenOnlyConnection(
  conn: TokenHealthConnection | null | undefined
): boolean {
  return (
    String(conn?.provider || "").toLowerCase() === "github" &&
    typeof conn?.accessToken === "string" &&
    conn.accessToken.trim().length > 0
  );
}

export function canClearGitHubNoRefreshTokenState(
  conn: TokenHealthConnection | null | undefined
): boolean {
  return (
    !conn?.testStatus ||
    conn.testStatus === "active" ||
    (conn.testStatus === "expired" && conn.errorCode === "no_refresh_token")
  );
}
