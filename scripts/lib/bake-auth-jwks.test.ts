import { describe, expect, it } from "vitest";
import { bakeStaticAuthJwks, parseAuthSigningEs256PrivateJwk } from "./bake-auth-jwks.ts";

const privateJwk = {
  alg: "ES256",
  crv: "P-256",
  d: "private",
  kid: "auth-signing",
  kty: "EC",
  x: "public-x",
  y: "public-y",
};

describe("bakeStaticAuthJwks", () => {
  it("derives the public ES256 JWKS from the Doppler-owned private key", () => {
    const baked = bakeStaticAuthJwks({
      dopplerConfig: "preview_1",
      envName: "preview_1",
      secrets: { AUTH_FORGE_ES256_PRIVATE_JWK: JSON.stringify(privateJwk) },
    });

    expect(JSON.parse(baked)).toEqual({
      keys: [
        {
          alg: "ES256",
          crv: "P-256",
          kid: "auth-signing",
          kty: "EC",
          x: "public-x",
          y: "public-y",
        },
      ],
    });
  });

  it("keeps the production forge-key opt-in fail closed", () => {
    expect(() =>
      bakeStaticAuthJwks({
        dopplerConfig: "prd",
        envName: "prd",
        secrets: { AUTH_FORGE_ES256_PRIVATE_JWK: JSON.stringify(privateJwk) },
      }),
    ).toThrow(/AUTH_FORGE_ALLOW_PRODUCTION=true/);
  });
});

describe("parseAuthSigningEs256PrivateJwk", () => {
  it("rejects a public-only or non-ES256 key", () => {
    expect(() =>
      parseAuthSigningEs256PrivateJwk(JSON.stringify({ ...privateJwk, d: undefined })),
    ).toThrow(/private ES256 \(P-256\) JWK/);
  });
});
