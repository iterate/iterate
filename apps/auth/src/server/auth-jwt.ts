import { jwt } from "better-auth/plugins";
import {
  parseAuthSigningEs256PrivateJwk,
  parseAuthSigningPrivateJwk,
} from "../../../../scripts/lib/bake-auth-jwks.ts";

export type AuthJwtPlugin = ReturnType<typeof jwt>;

/**
 * Better Auth JWT plugin backed by the immutable key(s) supplied by Doppler.
 *
 * The Ed25519 (EdDSA) key is always present. When an ES256 (P-256) key is also
 * supplied, it is returned as the *newest* key: better-auth's signJWT signs with
 * the latest key by `createdAt`, so new id_tokens and access tokens are signed
 * with ES256 while both public keys stay in the JWKS. This exists because
 * Cloudflare Access's generic-OIDC verifier accepts only RS/ES/PS-family — never
 * EdDSA. jose relying parties (OS, CLI, kernel) select the verification key by
 * `kid` from the JWKS, so they keep verifying without change.
 */
export function authJwt(privateJwkJson: string, es256PrivateJwkJson?: string): AuthJwtPlugin {
  const { d, ...publicJwk } = parseAuthSigningPrivateJwk(privateJwkJson);
  const ed25519Key = {
    id: publicJwk.kid,
    alg: "EdDSA" as const,
    crv: "Ed25519" as const,
    publicKey: JSON.stringify(publicJwk),
    privateKey: JSON.stringify({ ...publicJwk, d }),
    // Epoch 0 keeps the Ed25519 key strictly older than any ES256 key below, so
    // when both exist getLatestKey picks ES256.
    createdAt: new Date(0),
  };

  const es256Key = es256PrivateJwkJson
    ? (() => {
        const { d: es256D, ...es256PublicJwk } =
          parseAuthSigningEs256PrivateJwk(es256PrivateJwkJson);
        return {
          id: es256PublicJwk.kid,
          alg: "ES256" as const,
          crv: "P-256" as const,
          publicKey: JSON.stringify(es256PublicJwk),
          privateKey: JSON.stringify({ ...es256PublicJwk, d: es256D }),
          // Newer than the Ed25519 key so signJWT signs new tokens with ES256.
          createdAt: new Date(1),
        };
      })()
    : null;

  // getJwks returns every key: the JWKS route publishes each public half (with
  // its own alg/crv/kid), and signJWT signs with the newest.
  const keys = es256Key ? [es256Key, ed25519Key] : [ed25519Key];

  return jwt({
    jwks: {
      disablePrivateKeyEncryption: true,
      // keyPairConfig.alg drives the discovery doc's
      // id_token_signing_alg_values_supported. Advertise ES256 whenever the
      // ES256 key is the one new tokens are signed with; otherwise EdDSA.
      // ES256's curve (P-256) is implicit in better-auth's JWKOptions type
      // (crv is `never` for ES256); the actual P-256 key comes from the JWK.
      keyPairConfig: es256Key ? { alg: "ES256" } : { alg: "EdDSA", crv: "Ed25519" },
    },
    adapter: {
      getJwks: async () => keys,
      createJwk: async () => {
        throw new Error("Auth JWT signing keys are rotated in Doppler, not generated at runtime");
      },
    },
  });
}
