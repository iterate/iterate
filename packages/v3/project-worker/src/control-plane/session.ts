// The session — a signed cookie that says "you are this user". This is the FIRST-PARTY auth mechanism:
// browser pages carry it, no OAuth involved. OAuth only appears at the MCP edge, and its /authorize
// consent reuses whatever session this module minted. One login, reused everywhere. The token is the
// platform's one signed-claims codec (src/principal.ts) under the session secret.

import { signClaims, verifyClaims } from "../principal.ts";

/** The identity behind a browser session. */
export interface Session {
  /** Directory user id, e.g. `user_ada@example.com`. */
  sub: string;
  email: string;
  /** Issued-at (epoch seconds). */
  iat: number;
}

const COOKIE = "itx-control-plane-session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/** The session a token carries, or null: malformed, a bad signature, the wrong shape, or past
 *  MAX_AGE (the signed token is otherwise valid forever — Max-Age is only a browser hint, so a
 *  captured token could be replayed indefinitely). */
async function verifySession(token: string, secret: string): Promise<Session | null> {
  const session = (await verifyClaims(token, secret)) as Session | null;
  if (typeof session?.sub !== "string" || typeof session?.iat !== "number") return null;
  if (Math.floor(Date.now() / 1000) - session.iat > MAX_AGE) return null;
  return session;
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
  const token = await signClaims(session, secret);
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`;
}

/** `Set-Cookie` value that clears the session. */
export function clearSessionCookie(): string {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
