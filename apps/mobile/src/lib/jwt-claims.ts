// Client-side peek at the access token's payload — the phone's answer to
// "who am I signed in as?" without a network call. NOT verification (the
// server does that on every request); a malformed or unexpected token just
// reads as "no email". Expo-free on purpose so the node vitest lane covers it
// (Hermes and node both have atob).

/** The `email` claim of a JWT access token, or null for anything that isn't
 * a well-formed JWT carrying a string email. Never throws. */
export function emailFromJwt(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replaceAll("-", "+").replaceAll("_", "/"));
    const claims = JSON.parse(json);
    return typeof claims?.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}
