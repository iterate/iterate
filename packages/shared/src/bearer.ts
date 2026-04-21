export function parseBearerToken(authorizationHeader: string | null | undefined): string | null {
  if (!authorizationHeader) return null;
  const prefix = authorizationHeader.slice(0, 7);
  if (prefix.toLowerCase() !== "bearer ") return null;
  const token = authorizationHeader.slice(7).trim();
  return token || null;
}
