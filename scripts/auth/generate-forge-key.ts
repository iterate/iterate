import { parseArgs } from "node:util";
import { exportJWK, generateKeyPair } from "jose";

// Generate an iterate "forge" keypair.
//
// This is the environment's Auth signing key. Its PRIVATE half lives in
// Doppler and is shipped to Auth; relying-party deploys derive and ship only
// its PUBLIC half. Offline identity minting uses the same key, so whoever
// holds the private half can mint a session as any user — guard it like a
// production credential.
//
// The existing keys (kid `iterate-forge-dev` / `iterate-forge-preview` /
// `iterate-forge-prd`) were made with this script. Each environment gets its
// own kid so a leak is scoped to that environment.
//
//   pnpm tsx scripts/auth/generate-forge-key.ts --kid iterate-forge-prd
//
// Store the printed JWK as AUTH_FORGE_ES256_PRIVATE_JWK in the target Doppler
// config (for prod, also set AUTH_FORGE_ALLOW_PRODUCTION=true). The deploy
// strips the private `d` field before shipping the public half — nothing else
// to do.

const { values: args } = parseArgs({
  options: {
    kid: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (args.help || !args.kid) {
  console.log(
    "Usage: pnpm tsx scripts/auth/generate-forge-key.ts --kid <key-id>\n" +
      "  e.g. --kid iterate-forge-prd\n\n" +
      "Prints a private ES256 (P-256) JWK to stdout. Store it as\n" +
      "AUTH_FORGE_ES256_PRIVATE_JWK in the target Doppler config.",
  );
  process.exit(args.kid ? 0 : 1);
}

const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const jwk = await exportJWK(privateKey);

// Order matches the existing keys for easy diffing; alg/kid are what the mint
// script and the JWKS baker read.
const forgeJwk = {
  crv: jwk.crv,
  d: jwk.d,
  x: jwk.x,
  y: jwk.y,
  kty: jwk.kty,
  kid: args.kid,
  alg: "ES256",
};

console.log(JSON.stringify(forgeJwk));
