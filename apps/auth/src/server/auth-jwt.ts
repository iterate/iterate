import { jwt } from "better-auth/plugins";
import { parseAuthSigningPrivateJwk } from "../../../../scripts/lib/bake-auth-jwks.ts";

/** Better Auth JWT plugin backed by the one immutable key supplied by Doppler. */
export function authJwt(privateJwkJson: string | undefined) {
  // Schema generation needs the plugin's schema but has no runtime secrets.
  if (!privateJwkJson) return jwt();

  const { d, kid, ...publicJwk } = parseAuthSigningPrivateJwk(privateJwkJson);
  const key = {
    id: kid,
    alg: "EdDSA" as const,
    crv: "Ed25519" as const,
    publicKey: JSON.stringify(publicJwk),
    privateKey: JSON.stringify({ ...publicJwk, d }),
    createdAt: new Date(0),
  };

  return jwt({
    jwks: {
      disablePrivateKeyEncryption: true,
      keyPairConfig: { alg: "EdDSA", crv: "Ed25519" },
    },
    adapter: {
      getJwks: async () => [key],
      createJwk: async () => {
        throw new Error("Auth JWT signing keys are rotated in Doppler, not generated at runtime");
      },
    },
  });
}
