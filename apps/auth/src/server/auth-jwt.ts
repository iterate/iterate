import { jwt } from "better-auth/plugins";
import { parseAuthSigningEs256PrivateJwk } from "../../../../scripts/lib/bake-auth-jwks.ts";

export type AuthJwtPlugin = ReturnType<typeof jwt>;

/**
 * Better Auth JWT plugin backed by the single immutable ES256 (P-256) key
 * supplied by Doppler (`AUTH_FORGE_ES256_PRIVATE_JWK`). ES256 is the sole
 * signing algorithm: Cloudflare Access's generic-OIDC verifier accepts only
 * RS/ES/PS-family id_token signatures — never EdDSA. All id_tokens and access
 * tokens are signed with it, and its public half is the only key in the JWKS.
 * jose relying parties (OS, CLI, kernel) select the verification key by `kid`.
 */
export function authJwt(es256PrivateJwkJson: string): AuthJwtPlugin {
  const { d, ...publicJwk } = parseAuthSigningEs256PrivateJwk(es256PrivateJwkJson);
  const es256Key = {
    id: publicJwk.kid,
    alg: "ES256" as const,
    crv: "P-256" as const,
    publicKey: JSON.stringify(publicJwk),
    privateKey: JSON.stringify({ ...publicJwk, d }),
    createdAt: new Date(0),
  };

  return jwt({
    jwks: {
      disablePrivateKeyEncryption: true,
      // keyPairConfig.alg drives the discovery doc's
      // id_token_signing_alg_values_supported. ES256's curve (P-256) is
      // implicit in better-auth's JWKOptions type (crv is `never` for ES256);
      // the actual P-256 key comes from the JWK.
      keyPairConfig: { alg: "ES256" },
    },
    adapter: {
      getJwks: async () => [es256Key],
      createJwk: async () => {
        throw new Error("Auth JWT signing keys are rotated in Doppler, not generated at runtime");
      },
    },
  });
}
