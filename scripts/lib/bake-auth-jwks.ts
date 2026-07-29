/**
 * One Doppler-owned Ed25519 key signs Auth JWTs and lets relying-party deploys
 * derive the matching public JWKS without waiting for a deployed Auth worker.
 * The private half is shipped only to Auth; OS, Semaphore, and Streams receive
 * only the derived public key.
 */
export type AuthSigningPrivateJwk = Record<string, unknown> & {
  alg: "EdDSA";
  crv: "Ed25519";
  d: string;
  kid: string;
  kty: "OKP";
  x: string;
};

export function parseAuthSigningPrivateJwk(value: string): AuthSigningPrivateJwk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("AUTH_FORGE_PRIVATE_JWK must be valid JSON", { cause: error });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "AUTH_FORGE_PRIVATE_JWK must be a private Ed25519 JWK with alg, crv, d, kid, kty, and x",
    );
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.alg !== "EdDSA" ||
    candidate.crv !== "Ed25519" ||
    typeof candidate.d !== "string" ||
    candidate.d.length === 0 ||
    typeof candidate.kid !== "string" ||
    candidate.kid.length === 0 ||
    candidate.kty !== "OKP" ||
    typeof candidate.x !== "string" ||
    candidate.x.length === 0
  ) {
    throw new Error(
      "AUTH_FORGE_PRIVATE_JWK must be a private Ed25519 JWK with alg, crv, d, kid, kty, and x",
    );
  }

  return parsed as AuthSigningPrivateJwk;
}

type AuthSigningEnvironment = {
  /** The env name from envs.ts, e.g. "prd" or "preview_3". */
  envName: string;
  /** The env's Doppler config name, used in fail-closed errors. */
  dopplerConfig: string;
  /** The env's full Doppler secret map. */
  secrets: Record<string, string | undefined>;
};

export function authSigningPrivateJwkForEnvironment(
  input: AuthSigningEnvironment,
): AuthSigningPrivateJwk {
  const privateJwkJson = input.secrets.AUTH_FORGE_PRIVATE_JWK?.trim();
  if (!privateJwkJson) {
    throw new Error(`${input.dopplerConfig} is missing AUTH_FORGE_PRIVATE_JWK`);
  }

  if (input.envName === "prd") {
    const allowProduction = /^(1|true|yes)$/i.test(input.secrets.AUTH_FORGE_ALLOW_PRODUCTION ?? "");
    if (!allowProduction) {
      throw new Error(
        `AUTH_FORGE_PRIVATE_JWK is present in ${input.dopplerConfig} (production-serving) without ` +
          "AUTH_FORGE_ALLOW_PRODUCTION=true. Set the flag to deliberately authorize production " +
          "Auth signing and offline identity minting.",
      );
    }
  }

  return parseAuthSigningPrivateJwk(privateJwkJson);
}

/**
 * Optional second signing key: an ES256 (P-256) private JWK. Cloudflare Access's
 * generic-OIDC verifier only accepts RS/ES/PS-family id_token signatures — never
 * EdDSA — so when this key is present Auth signs new id/access tokens with ES256
 * (see auth-jwt.ts) while still publishing the Ed25519 public key. jose relying
 * parties select the verification key by `kid`, so both algorithms verify.
 */
export type AuthSigningEs256PrivateJwk = Record<string, unknown> & {
  alg: "ES256";
  crv: "P-256";
  d: string;
  kid: string;
  kty: "EC";
  x: string;
  y: string;
};

export function parseAuthSigningEs256PrivateJwk(value: string): AuthSigningEs256PrivateJwk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("AUTH_FORGE_ES256_PRIVATE_JWK must be valid JSON", { cause: error });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "AUTH_FORGE_ES256_PRIVATE_JWK must be a private ES256 (P-256) JWK with alg, crv, d, kid, kty, x, and y",
    );
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.alg !== "ES256" ||
    candidate.crv !== "P-256" ||
    typeof candidate.d !== "string" ||
    candidate.d.length === 0 ||
    typeof candidate.kid !== "string" ||
    candidate.kid.length === 0 ||
    candidate.kty !== "EC" ||
    typeof candidate.x !== "string" ||
    candidate.x.length === 0 ||
    typeof candidate.y !== "string" ||
    candidate.y.length === 0
  ) {
    throw new Error(
      "AUTH_FORGE_ES256_PRIVATE_JWK must be a private ES256 (P-256) JWK with alg, crv, d, kid, kty, x, and y",
    );
  }

  return parsed as AuthSigningEs256PrivateJwk;
}

/**
 * The ES256 signing key for an environment, or null when the env has no
 * `AUTH_FORGE_ES256_PRIVATE_JWK`. Optional so envs that have not adopted the
 * second key keep signing EdDSA-only.
 */
export function authSigningEs256PrivateJwkForEnvironment(
  input: AuthSigningEnvironment,
): AuthSigningEs256PrivateJwk | null {
  const privateJwkJson = input.secrets.AUTH_FORGE_ES256_PRIVATE_JWK?.trim();
  if (!privateJwkJson) return null;
  return parseAuthSigningEs256PrivateJwk(privateJwkJson);
}

export function bakeStaticAuthJwks(input: AuthSigningEnvironment): string {
  const { d: _privateKey, ...publicJwk } = authSigningPrivateJwkForEnvironment(input);
  // When the env also carries an ES256 key, publish its public half so relying
  // parties (OS, Semaphore) that verify tokens against this baked JWKS accept
  // the ES256-signed tokens Auth now issues, selecting the key by `kid`.
  const es256 = authSigningEs256PrivateJwkForEnvironment(input);
  if (es256) {
    const { d: _es256Private, ...es256Public } = es256;
    return JSON.stringify({ keys: [es256Public, publicJwk] });
  }
  return JSON.stringify({ keys: [publicJwk] });
}
