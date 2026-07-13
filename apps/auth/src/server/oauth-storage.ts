// better-auth's oauth-provider stores client secrets and opaque tokens as
// unsalted SHA-256 base64url. Seeded secrets and private token introspection
// must use the provider's exact representation.
export async function hashOAuthStoredValue(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
