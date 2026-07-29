import assert from "node:assert/strict";
import { test } from "node:test";
import { betterAuth } from "better-auth";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { authJwt } from "./auth-jwt.ts";

test("signs ES256 and publishes the single Doppler-owned key", async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = { ...(await exportJWK(privateKey)), alg: "ES256", kid: "from-doppler" };
  const auth = betterAuth({
    baseURL: "https://auth.example.com",
    secret: "test-secret-at-least-thirty-two-characters",
    plugins: [authJwt(JSON.stringify(privateJwk))],
  });

  const { token } = await auth.api.signJWT({ body: { payload: { sub: "usr_test" } } });
  const jwks = await auth.api.getJwks();

  // Exactly one key is published, and it does not carry the private component.
  assert.equal(jwks.keys.length, 1);
  assert.equal(Object.hasOwn(jwks.keys[0]!, "d"), false);
  assert.equal(jwks.keys[0]!.kid, "from-doppler");
  assert.equal(jwks.keys[0]!.alg, "ES256");

  // The token is signed ES256 and verifies against the published JWKS by kid —
  // exactly what jose relying parties (and Cloudflare Access, which only
  // accepts ES*/RS*/PS*) do.
  assert.equal(token.split(".").length, 3);
  const verified = await jwtVerify(token, createLocalJWKSet(jwks));
  assert.equal(verified.protectedHeader.alg, "ES256");
  assert.equal(verified.protectedHeader.kid, "from-doppler");
  assert.equal(verified.payload.sub, "usr_test");
});
