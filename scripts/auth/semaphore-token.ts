import { semaphoreEnvs } from "../../envs.ts";
import { mintForgedAccessToken } from "./forge-token.ts";

/**
 * Bearer tokens for semaphore CLI callers (the repo-root preview tooling, the
 * inventory seed script, and the semaphore e2e suites).
 *
 * Semaphore sits behind the same apps/auth relying-party auth as os, so CLIs
 * authenticate with a real identity: an explicit pre-minted bearer token via
 * SEMAPHORE_API_TOKEN, else an admin access token forge-minted offline from
 * AUTH_FORGE_ES256_PRIVATE_JWK (the same mechanism as `pnpm auth:mint`).
 */

/** Resolve the auth issuer for a deployed semaphore base URL via the root envs.ts. */
export function authIssuerForSemaphoreBaseUrl(baseUrl: string): string {
  const override = process.env.SEMAPHORE_AUTH_ISSUER?.trim();
  if (override) return override;

  const origin = new URL(baseUrl).origin;
  const env = Object.values(semaphoreEnvs).find(
    (candidate) => new URL(candidate.baseUrl).origin === origin,
  );
  if (env) return `${env.authBaseUrl}/api/auth`;

  const fromEnv = process.env.APP_CONFIG_ITERATE_AUTH__ISSUER?.trim();
  if (fromEnv) return fromEnv;

  throw new Error(
    `Cannot resolve the auth issuer for semaphore at ${baseUrl}: it is not a deployed env in envs.ts. ` +
      "Set SEMAPHORE_AUTH_ISSUER (or APP_CONFIG_ITERATE_AUTH__ISSUER) explicitly.",
  );
}

/**
 * Async bearer-token provider for createSemaphoreClient. Prefers an explicit
 * SEMAPHORE_API_TOKEN; otherwise forge-mints an admin access token (audience
 * = the semaphore deployment's base URL origin). A fresh token is minted for
 * every request so lifecycle commands may safely outlive the one-hour token
 * TTL.
 */
export function createSemaphoreTokenProvider(input: {
  baseUrl: string;
  /** Identity recorded in the token, e.g. `preview-cli@iterate.com`. */
  email: string;
  env?: NodeJS.ProcessEnv;
}): () => Promise<string> {
  const env = input.env ?? process.env;

  return async () => {
    const explicit = env.SEMAPHORE_API_TOKEN?.trim();
    if (explicit) return explicit;

    const forgePrivateJwk = env.AUTH_FORGE_ES256_PRIVATE_JWK?.trim();
    if (!forgePrivateJwk) {
      throw new Error(
        "Authenticating against semaphore needs SEMAPHORE_API_TOKEN (a pre-minted bearer token) " +
          "or AUTH_FORGE_ES256_PRIVATE_JWK in the environment. Run under a Doppler config that carries " +
          "the forge key (e.g. `doppler run --project _shared --config prd`).",
      );
    }

    return await mintForgedAccessToken({
      forgePrivateJwk,
      issuer: authIssuerForSemaphoreBaseUrl(input.baseUrl),
      audience: new URL(input.baseUrl).origin,
      email: input.email,
      admin: true,
    });
  };
}
