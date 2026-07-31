import { createRemoteJWKSet, jwtVerify } from "jose";

// ---------------------------------------------------------------------------
// The WALL — the kernel's ONLY identity mechanism.
//
// The kernel does no login. It runs one of exactly two ways:
//   1. WIDE OPEN — no wall configured; every caller is anonymous (users don't exist / don't matter).
//   2. BEHIND A WALL — something on the ingress path authenticated the human and injected a signed JWT
//      on a header; the kernel just VERIFIES it and forwards.
//
// Cloudflare Access is a wall (it injects `Cf-Access-Jwt-Assertion` at the edge). An auth.iterate.com
// forward-auth proxy is a wall (it does the OIDC dance and injects its own JWT). To the kernel they are
// IDENTICAL — a header name + a JWKS + an issuer (+ optional audience). No OIDC / cookies / PKCE / DCR
// in the kernel: that all lives in the wall, where it belongs. This single verifier is the whole of the
// old `auth-iterate.ts` (OIDC) and `auth-cloudflare-access.ts`, collapsed.
// ---------------------------------------------------------------------------

export type WallConfig = {
  header: string; // where the wall put the JWT — e.g. "cf-access-jwt-assertion", or "authorization" (Bearer)
  jwksUrl: string; // the wall's JWKS (its public keys)
  issuer: string; // expected `iss`
  audience?: string; // expected `aud`, when the wall pins one
};

type Credential = { format: string; issuer: string } & Record<string, unknown>;

// Verify the JWT the wall injected. Present-but-invalid (or absent) => null = anonymous — a valid state
// (maybe the wall isn't in front on this path). We hold the raw jwt internally; `published()` (kernel.ts)
// strips it before it crosses any boundary. A wall JWT rides on a HEADER the browser can't forge (the
// wall sets it; we verify the signature) — so there's no cookie/CSRF concern.
export function wallVerifier(wall: WallConfig): (request: Request) => Promise<Credential | null> {
  const jwks = createRemoteJWKSet(new URL(wall.jwksUrl));
  return async (request) => {
    const raw = request.headers.get(wall.header);
    const token = raw?.startsWith("Bearer ") ? raw.slice(7) : raw; // tolerate `Authorization: Bearer <jwt>`
    if (!token) return null;
    try {
      await jwtVerify(token, jwks, {
        issuer: wall.issuer,
        ...(wall.audience === undefined ? {} : { audience: wall.audience }),
      });
      return { format: "jwt", issuer: wall.issuer, jwt: token };
    } catch {
      return null;
    }
  };
}
