type AuthSigningEnvironment = {
  /** The env name from envs.ts, e.g. "prd" or "preview_3". */
  envName: string;
  /** The env's Doppler config name, used in fail-closed errors. */
  dopplerConfig: string;
  /** The env's full Doppler secret map. */
  secrets: Record<string, string | undefined>;
};

/**
 * The single ES256 (P-256) private JWK that signs Auth JWTs and lets
 * relying-party deploys derive the matching public JWKS without waiting for a
 * deployed Auth worker. The private half is shipped only to Auth; OS,
 * Semaphore, and Streams receive only the derived public key. ES256 is the
 * sole algorithm: Cloudflare Access's generic-OIDC verifier accepts only
 * RS/ES/PS-family id_token signatures — never EdDSA.
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

  if (typeof parsed !== "object" || !parsed || Array.isArray(parsed)) {
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
 * The single ES256 signing key for an environment. Required: every env that
 * serves Auth (or bakes a relying-party JWKS) must carry
 * `AUTH_FORGE_ES256_PRIVATE_JWK`. Production is additionally gated behind
 * `AUTH_FORGE_ALLOW_PRODUCTION=true` — the same fail-closed opt-in that
 * protected the Ed25519 key — because holding this key allows offline identity
 * minting against production.
 */
export function authSigningEs256PrivateJwkForEnvironment(
  input: AuthSigningEnvironment,
): AuthSigningEs256PrivateJwk {
  const privateJwkJson = input.secrets.AUTH_FORGE_ES256_PRIVATE_JWK?.trim();
  if (!privateJwkJson) {
    throw new Error(`${input.dopplerConfig} is missing AUTH_FORGE_ES256_PRIVATE_JWK`);
  }

  if (input.envName === "prd") {
    const allowProduction = /^(1|true|yes)$/i.test(input.secrets.AUTH_FORGE_ALLOW_PRODUCTION ?? "");
    if (!allowProduction) {
      throw new Error(
        `AUTH_FORGE_ES256_PRIVATE_JWK is present in ${input.dopplerConfig} (production-serving) without ` +
          "AUTH_FORGE_ALLOW_PRODUCTION=true. Set the flag to deliberately authorize production " +
          "Auth signing and offline identity minting.",
      );
    }
  }

  return parseAuthSigningEs256PrivateJwk(privateJwkJson);
}

export function bakeStaticAuthJwks(input: AuthSigningEnvironment): string {
  // ES256 is the sole signing key: publish only its public half. Relying
  // parties (OS, Semaphore) verify tokens against this baked JWKS, selecting
  // the key by `kid`.
  const es256 = authSigningEs256PrivateJwkForEnvironment(input);
  const { d: _es256Private, ...es256Public } = es256;
  return JSON.stringify({ keys: [es256Public] });
}
