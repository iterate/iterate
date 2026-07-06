import { SignJWT, importJWK, type JWK } from "jose";
import {
  ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM,
  ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM,
  ITERATE_IS_ADMIN_CLAIM,
  ITERATE_ROLE_CLAIM,
} from "@iterate-com/shared/auth-claims";

/**
 * Offline identity minting with the forge key — the signing core behind
 * `pnpm auth:mint` (scripts/auth/mint-session.ts), shared with every CLI that
 * must authenticate against a relying-party worker (os, semaphore).
 *
 * Relying parties trust JWTs signed by any key in their deploy-baked JWKS,
 * which includes the forge public key (scripts/lib/bake-auth-jwks.ts). This
 * signs tokens with the private half from Doppler (AUTH_FORGE_PRIVATE_JWK) —
 * fully offline, no auth worker involved.
 */

/** Inputs for one forge-signed access token (the bearer credential relying parties verify). */
export interface ForgeAccessTokenInput {
  /** The forge private JWK as its JSON string (Doppler AUTH_FORGE_PRIVATE_JWK). */
  forgePrivateJwk: string;
  /** Token issuer — the env's auth issuer, e.g. https://auth.iterate.com/api/auth */
  issuer: string;
  /** Token audience — the relying worker's OAuth resource (usually its base URL origin). */
  audience: string;
  /** Identity email; the subject id derives from it unless `sub` is passed. */
  email: string;
  sub?: string;
  admin?: boolean;
  ttlSeconds?: number;
  /** Organization claims: [{id,slug,name,role}]. */
  organizations?: unknown[];
  /** Project claims: [{id,slug,organizationId}]. */
  projects?: unknown[];
  /** Extra access-token claims to merge. */
  claims?: Record<string, unknown>;
}

/** A forge JWK plus the signing key and protected header derived from it. */
async function importForgeKey(forgePrivateJwk: string) {
  const forgeJwk = JSON.parse(forgePrivateJwk) as JWK & { kid?: string; alg?: string };
  const alg = forgeJwk.alg ?? "EdDSA";
  const key = await importJWK(forgeJwk, alg);
  return { key, protectedHeader: { alg, kid: forgeJwk.kid } as const };
}

export function forgedSubjectForEmail(email: string) {
  return `usr_forged_${email.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
}

/** Sign an access token with the forge key. Verified by any worker whose baked JWKS carries the forge public key. */
export async function mintForgedAccessToken(input: ForgeAccessTokenInput): Promise<string> {
  const { key, protectedHeader } = await importForgeKey(input.forgePrivateJwk);
  const now = Math.floor(Date.now() / 1000);
  const ttlSeconds = input.ttlSeconds ?? 3600;
  const sub = input.sub ?? forgedSubjectForEmail(input.email);
  const sid = `ses_forged_${Math.random().toString(36).slice(2, 10)}`;

  return await new SignJWT({
    email: input.email,
    scope: "openid profile email",
    scopes: ["openid", "profile", "email"],
    sid,
    [ITERATE_IS_ADMIN_CLAIM]: input.admin ?? false,
    [ITERATE_ROLE_CLAIM]: input.admin ? "admin" : null,
    [ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM]: input.organizations ?? [],
    [ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM]: input.projects ?? [],
    ...input.claims,
  })
    .setProtectedHeader(protectedHeader)
    .setSubject(sub)
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key);
}

/** Inputs for one forge-signed id token (audience = the relying party's OAuth client id). */
export interface ForgeIdTokenInput {
  forgePrivateJwk: string;
  issuer: string;
  /** The relying party's OAuth client id (id-token audience). */
  clientId: string;
  email: string;
  sub?: string;
  name?: string;
  admin?: boolean;
  ttlSeconds?: number;
}

/** Sign an id token with the forge key (browser session-from-token lane needs an access+id pair). */
export async function mintForgedIdToken(input: ForgeIdTokenInput): Promise<string> {
  const { key, protectedHeader } = await importForgeKey(input.forgePrivateJwk);
  const now = Math.floor(Date.now() / 1000);
  const ttlSeconds = input.ttlSeconds ?? 3600;
  const sub = input.sub ?? forgedSubjectForEmail(input.email);

  return await new SignJWT({
    email: input.email,
    name: input.name ?? input.email.split("@")[0]!,
    email_verified: true,
    [ITERATE_IS_ADMIN_CLAIM]: input.admin ?? false,
    [ITERATE_ROLE_CLAIM]: input.admin ? "admin" : null,
  })
    .setProtectedHeader(protectedHeader)
    .setSubject(sub)
    .setIssuer(input.issuer)
    .setAudience(input.clientId)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key);
}
