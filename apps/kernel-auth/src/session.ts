// The session — a signed cookie that says "you are this user". This is the FIRST-PARTY auth mechanism
// (design §2): browser pages carry it, no OAuth involved. OAuth only appears at the MCP/device edge, and
// its /authorize consent reuses whatever session this module minted. One login, reused everywhere.

/** The identity behind a browser session. */
export interface Session {
  /** Directory user id, e.g. `user:ada@example.com`. */
  sub: string;
  email: string;
  /** Issued-at (epoch seconds). */
  iat: number;
}

const COOKIE = "kernel_auth_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function unb64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** `<payload>.<sig>`, payload = base64url(JSON(session)), sig = base64url(HMAC-SHA256(payload)). */
export async function signSession(session: Session, secret: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(session)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

/** Verify + decode a token; null if malformed or the signature doesn't check out. */
export async function verifySession(token: string, secret: string): Promise<Session | null> {
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      unb64url(sig),
      enc.encode(payload),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    return JSON.parse(dec.decode(unb64url(payload))) as Session;
  } catch {
    return null;
  }
}

function readCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The current session for a request, or null if unauthenticated. */
export async function currentSession(request: Request, secret: string): Promise<Session | null> {
  const token = readCookie(request);
  return token ? verifySession(token, secret) : null;
}

/** `Set-Cookie` value that establishes the session. */
export async function setSessionCookie(session: Session, secret: string): Promise<string> {
  const token = await signSession(session, secret);
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`;
}

/** `Set-Cookie` value that clears the session. */
export function clearSessionCookie(): string {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
