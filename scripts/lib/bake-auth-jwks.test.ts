import { describe, expect, it } from "vitest";
import { bakeStaticAuthJwks, parseAuthSigningPrivateJwk } from "./bake-auth-jwks.ts";

const privateJwk = {
  alg: "EdDSA",
  crv: "Ed25519",
  d: "private",
  kid: "auth-signing",
  kty: "OKP",
  x: "public",
};

describe("bakeStaticAuthJwks", () => {
  it("derives the public JWKS from the Doppler-owned private key", () => {
    const baked = bakeStaticAuthJwks({
      dopplerConfig: "preview_1",
      envName: "preview_1",
      secrets: { AUTH_FORGE_PRIVATE_JWK: JSON.stringify(privateJwk) },
    });

    expect(JSON.parse(baked)).toEqual({
      keys: [{ alg: "EdDSA", crv: "Ed25519", kid: "auth-signing", kty: "OKP", x: "public" }],
    });
  });

  it("keeps the production forge-key opt-in fail closed", () => {
    expect(() =>
      bakeStaticAuthJwks({
        dopplerConfig: "prd",
        envName: "prd",
        secrets: { AUTH_FORGE_PRIVATE_JWK: JSON.stringify(privateJwk) },
      }),
    ).toThrow(/AUTH_FORGE_ALLOW_PRODUCTION=true/);
  });
});

describe("parseAuthSigningPrivateJwk", () => {
  it("rejects a public-only or non-Ed25519 key", () => {
    expect(() =>
      parseAuthSigningPrivateJwk(JSON.stringify({ ...privateJwk, d: undefined })),
    ).toThrow(/private Ed25519 JWK/);
  });
});
