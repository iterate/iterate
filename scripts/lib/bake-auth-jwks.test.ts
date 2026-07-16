import { describe, expect, it } from "vitest";
import { bakeStaticAuthJwks } from "./bake-auth-jwks.ts";

describe("bakeStaticAuthJwks", () => {
  it("ignores a pinned Doppler JWKS when baking deploy JWKS", async () => {
    const baked = await bakeStaticAuthJwks({
      authBaseUrl: "https://auth.iterate.com",
      dopplerConfig: "prd",
      envName: "prd",
      secrets: {
        APP_CONFIG_ITERATE_AUTH__JWKS: JSON.stringify(jwks("pinned")),
      },
      fetchJwks: async () => jwks("live"),
    });

    expect(JSON.parse(baked)).toEqual(jwks("live"));
  });

  it("fails closed when the live auth JWKS cannot be fetched", async () => {
    await expect(
      bakeStaticAuthJwks({
        authBaseUrl: "https://auth.iterate.com",
        dopplerConfig: "prd",
        envName: "prd",
        secrets: {
          APP_CONFIG_ITERATE_AUTH__JWKS: JSON.stringify(jwks("pinned")),
        },
        fetchJwks: async () => {
          throw new Error("auth unavailable");
        },
      }),
    ).rejects.toThrow(/auth unavailable/);
  });

  it("merges the forge public key into the live auth JWKS", async () => {
    const baked = await bakeStaticAuthJwks({
      authBaseUrl: "https://auth.iterate.com",
      dopplerConfig: "prd",
      envName: "prd",
      secrets: {
        AUTH_FORGE_ALLOW_PRODUCTION: "true",
        AUTH_FORGE_PRIVATE_JWK: JSON.stringify({ ...key("forge"), d: "private" }),
      },
      fetchJwks: async () => jwks("live"),
    });

    expect(JSON.parse(baked)).toEqual({ keys: [key("live"), key("forge")] });
  });
});

function jwks(kid: string) {
  return { keys: [key(kid)] };
}

function key(kid: string) {
  return {
    alg: "EdDSA",
    crv: "Ed25519",
    kid,
    kty: "OKP",
    x: `${kid}-public`,
  };
}
