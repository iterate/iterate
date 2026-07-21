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

export function bakeStaticAuthJwks(input: AuthSigningEnvironment): string {
  const { d: _privateKey, ...publicJwk } = authSigningPrivateJwkForEnvironment(input);
  return JSON.stringify({ keys: [publicJwk] });
}
