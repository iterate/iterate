import { z } from "zod";

/**
 * Local verification for project-app-session tokens — the short-lived
 * user-on-project JWTs the auth worker mints for project app hosts (see
 * apps/auth/src/server/project-app-session.ts, which signs HS256 via
 * better-auth's jose wrapper). Verifying here with the shared
 * APP_CONFIG_PROJECT_APP_SESSION_SECRET keeps the hot paths — the per-request
 * project-host gate and the /api credential lane — free of auth-worker hops:
 * signature + expiry are pure crypto, and membership was checked when the
 * token was minted (the 15-minute TTL bounds revocation lag).
 *
 * Deliberately a dedicated secret, not the better-auth master secret: sharing
 * it with os only grants "verify (or forge) project-app-sessions", never the
 * rest of better-auth's artifacts, and it rotates alone.
 */

const ProjectAppSessionClaims = z
  .object({
    audience: z.string(),
    exp: z.number().int(),
    projectId: z.string().trim().min(1).max(256),
    type: z.literal("project-app-session"),
    userId: z.string().trim().min(1).max(256),
  })
  .loose();

type ProjectAppSessionClaims = z.infer<typeof ProjectAppSessionClaims>;

/**
 * The auth worker's `validateProjectAppSession` shape, satisfied locally:
 * signature + expiry + audience + project binding from the claims alone.
 * The live membership re-check the auth worker performs is deliberately
 * absent — that is the whole point of the local lane; the TTL bounds it.
 */
export function localProjectAppSessionValidator(secret: string) {
  return async (input: {
    audience: string;
    projectId: string;
    token: string;
  }): Promise<{ expiresAt: number; userId: string } | null> => {
    const claims = await verifyProjectAppSessionToken(input.token, secret);
    if (claims === null) return null;
    if (claims.audience !== input.audience || claims.projectId !== input.projectId) return null;
    return { expiresAt: claims.exp, userId: claims.userId };
  };
}

const encoder = new TextEncoder();

function decodeBase64Url(segment: string): Uint8Array | null {
  try {
    const swapped = segment.replaceAll("-", "+").replaceAll("_", "/");
    const padded = swapped + "=".repeat((4 - (swapped.length % 4)) % 4);
    const raw = atob(padded);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Verify signature, shape, and expiry; answer the claims or null. Never
 * throws — a malformed token is an ordinary refusal, and the signature check
 * rides crypto.subtle.verify (constant-time by construction).
 */
export async function verifyProjectAppSessionToken(
  token: string,
  secret: string,
): Promise<ProjectAppSessionClaims | null> {
  const [headerSegment, payloadSegment, signatureSegment, extra] = token.split(".");
  if (!headerSegment || !payloadSegment || !signatureSegment || extra !== undefined) return null;

  const signature = decodeBase64Url(signatureSegment);
  const headerBytes = decodeBase64Url(headerSegment);
  const payloadBytes = decodeBase64Url(payloadSegment);
  if (!signature || !headerBytes || !payloadBytes) return null;

  try {
    const header = JSON.parse(new TextDecoder().decode(headerBytes)) as { alg?: string };
    if (header.alg !== "HS256") return null;

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature as unknown as BufferSource,
      encoder.encode(`${headerSegment}.${payloadSegment}`),
    );
    if (!valid) return null;

    const claims = ProjectAppSessionClaims.safeParse(
      JSON.parse(new TextDecoder().decode(payloadBytes)),
    );
    if (!claims.success) return null;
    if (claims.data.exp * 1000 <= Date.now()) return null;
    return claims.data;
  } catch {
    return null;
  }
}
