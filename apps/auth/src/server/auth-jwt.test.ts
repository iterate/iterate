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
  assert.equal(jwks.keys[0]!.kid, "from-doppler");
  assert.equal(verified.protectedHeader.kid, "from-doppler");
  assert.equal(verified.payload.sub, "usr_test");
});

test("with an ES256 key, signs ES256 and publishes both public keys", async () => {
  const { privateKey: edPrivateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const edPrivateJwk = {
    ...(await exportJWK(edPrivateKey)),
    alg: "EdDSA",
    kid: "ed25519-from-doppler",
  };
  const { privateKey: ecPrivateKey } = await generateKeyPair("ES256", { extractable: true });
  const es256PrivateJwk = {
    ...(await exportJWK(ecPrivateKey)),
    alg: "ES256",
    kid: "es256-from-doppler",
  };

  const auth = betterAuth({
    baseURL: "https://auth.example.com",
    secret: "test-secret-at-least-thirty-two-characters",
    plugins: [authJwt(JSON.stringify(edPrivateJwk), JSON.stringify(es256PrivateJwk))],
  });

  const { token } = await auth.api.signJWT({ body: { payload: { sub: "usr_test" } } });
  const jwks = await auth.api.getJwks();

  // Both public keys are published; neither carries the private component.
  assert.equal(jwks.keys.length, 2);
  assert.equal(
    jwks.keys.every((k) => !Object.hasOwn(k, "d")),
    true,
  );
  const kids = jwks.keys.map((k) => k.kid).sort();
  assert.deepEqual(kids, ["ed25519-from-doppler", "es256-from-doppler"]);
  const algs = jwks.keys.map((k) => k.alg).sort();
  assert.deepEqual(algs, ["ES256", "EdDSA"]);

  // The token is signed with the ES256 key (newest), and verifies against the
  // published JWKS by kid — exactly what jose relying parties (and Cloudflare
  // Access, which only accepts ES*/RS*/PS*) do.
  assert.equal(token.split(".").length, 3);
  const verified = await jwtVerify(token, createLocalJWKSet(jwks));
  assert.equal(verified.protectedHeader.alg, "ES256");
  assert.equal(verified.protectedHeader.kid, "es256-from-doppler");
  assert.equal(verified.payload.sub, "usr_test");
});
