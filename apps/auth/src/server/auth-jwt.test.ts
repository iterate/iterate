import assert from "node:assert/strict";
import { test } from "node:test";
import { betterAuth } from "better-auth";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { authJwt } from "./auth-jwt.ts";

test("signs and publishes the same Doppler-owned key", async () => {
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const privateJwk = { ...(await exportJWK(privateKey)), alg: "EdDSA", kid: "from-doppler" };
  const auth = betterAuth({
    baseURL: "https://auth.example.com",
    secret: "test-secret-at-least-thirty-two-characters",
    plugins: [authJwt(JSON.stringify(privateJwk))],
  });

  const { token } = await auth.api.signJWT({ body: { payload: { sub: "usr_test" } } });
  const jwks = await auth.api.getJwks();
  const verified = await jwtVerify(token, createLocalJWKSet(jwks));

  assert.equal(jwks.keys.length, 1);
  assert.equal(Object.hasOwn(jwks.keys[0]!, "d"), false);
  assert.equal(verified.protectedHeader.kid, "from-doppler");
  assert.equal(verified.payload.sub, "usr_test");
});
