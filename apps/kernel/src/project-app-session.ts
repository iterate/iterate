// The project-app-session token — the RIGHT credential for a project app.
//
// A project app (the OS dashboard vessel, or any remote app) must NEVER carry the user's
// auth.iterate.com access token: that token is the user's key to ALL of auth, wildly over-privileged
// for one project. Instead the kernel's front door mints THIS — a narrow, short-lived (15 min),
// project-scoped grant that says "userId may act in projectId" — and hands it to the app. The app
// acts as the user, scoped to that one project, holding nothing replayable upstream. Right token for
// the layer (review #3).
//
// Mirrors apps/os's `auth/project-app-session-token.ts`: HS256, VERIFIED LOCALLY against a shared
// secret (no auth-worker hop on the hot path). Here the same worker both mints (front door) and
// verifies (`/api`), so one `PROJECT_APP_SESSION_SECRET` per deployment is self-consistent. Membership
// is checked ONCE, at mint time, against the configured directory — the token is the proof thereafter.

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64urlEncode = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlDecode = (s: string): Uint8Array | null => {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};
const hmacKey = (secret: string, usages: ("sign" | "verify")[]): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );

// Mint a project-app-session (default 15-minute TTL, matching apps/os). Callers MUST check membership
// (directory.access) before minting — the token is unconditional proof of access to its project.
export async function mintProjectAppSession(
  secret: string,
  claims: { projectId: string; userId: string },
  ttlSeconds = 900,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64urlEncode(
    enc.encode(
      JSON.stringify({ ...claims, type: "project-app-session", iat: now, exp: now + ttlSeconds }),
    ),
  );
  const key = await hmacKey(secret, ["sign"]);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${payload}`)),
  );
  return `${header}.${payload}.${b64urlEncode(sig)}`;
}

// Verify a project-app-session locally (signature + type + expiry). Returns the scoped grant, or null
// for anything malformed/forged/expired — the caller then treats it as no credential (fail-safe).
export async function verifyProjectAppSessionToken(
  secret: string,
  token: string,
): Promise<{ projectId: string; userId: string } | null> {
  const [header, payload, signature, extra] = token.split(".");
  if (!header || !payload || !signature || extra !== undefined) return null;
  const sig = b64urlDecode(signature);
  const headerBytes = b64urlDecode(header);
  const payloadBytes = b64urlDecode(payload);
  if (!sig || !headerBytes || !payloadBytes) return null;
  try {
    if ((JSON.parse(dec.decode(headerBytes)) as { alg?: string }).alg !== "HS256") return null;
    const key = await hmacKey(secret, ["verify"]);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sig as unknown as BufferSource,
      enc.encode(`${header}.${payload}`),
    );
    if (!valid) return null;
    const claims = JSON.parse(dec.decode(payloadBytes)) as {
      projectId?: unknown;
      userId?: unknown;
      type?: unknown;
      exp?: unknown;
    };
    if (claims.type !== "project-app-session") return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
    if (typeof claims.projectId !== "string" || typeof claims.userId !== "string") return null;
    return { projectId: claims.projectId, userId: claims.userId };
  } catch {
    return null;
  }
}
