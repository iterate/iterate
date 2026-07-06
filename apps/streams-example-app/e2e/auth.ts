import { streamsExampleEnvs } from "../../../envs.ts";
import { mintForgedAccessToken, mintForgedIdToken } from "../../../scripts/auth/forge-token.ts";

/**
 * Forge-minted admin credentials for e2e against a DEPLOYED playground —
 * the same mechanism as `pnpm auth:mint` and semaphore's e2e. Local dev
 * (localhost WORKER_URL, or none) is auth-less, so everything here resolves
 * to null and the suites run exactly as before.
 */

/** The deployed env matching WORKER_URL, or null for local dev. */
export function resolveDeployedEnv(workerUrl: string | undefined) {
  if (!workerUrl) return null;
  const origin = new URL(workerUrl).origin;
  if (new URL(origin).hostname === "localhost" || new URL(origin).hostname === "127.0.0.1") {
    return null;
  }
  return (
    Object.values(streamsExampleEnvs).find(
      (candidate) => new URL(candidate.baseUrl).origin === origin,
    ) ?? null
  );
}

/** Mint an admin access token for the deployed playground (null on local dev). */
export async function mintAdminAccessToken(workerUrl: string | undefined) {
  const env = resolveDeployedEnv(workerUrl);
  if (!env) return null;
  const forgePrivateJwk = process.env.AUTH_FORGE_PRIVATE_JWK?.trim();
  if (!forgePrivateJwk) {
    throw new Error(
      "AUTH_FORGE_PRIVATE_JWK is required to run e2e against a deployed playground. " +
        "Run under the env's Doppler config (doppler run --project streams-example-app --config <env> -- ...).",
    );
  }
  return await mintForgedAccessToken({
    forgePrivateJwk,
    issuer: `${env.authBaseUrl}/api/auth`,
    audience: new URL(env.baseUrl).origin,
    email: "streams-e2e@iterate.com",
    admin: true,
  });
}

/**
 * Mint the access+id pair a browser session needs, for
 * `/api/iterate-auth/session-from-token` (the Playwright sign-in lane).
 */
export async function mintAdminBrowserTokens(workerUrl: string | undefined) {
  const env = resolveDeployedEnv(workerUrl);
  if (!env) return null;
  const forgePrivateJwk = process.env.AUTH_FORGE_PRIVATE_JWK?.trim();
  const clientId = process.env.APP_CONFIG_ITERATE_AUTH__CLIENT_ID?.trim();
  if (!forgePrivateJwk || !clientId) {
    throw new Error(
      "AUTH_FORGE_PRIVATE_JWK and APP_CONFIG_ITERATE_AUTH__CLIENT_ID are required to run browser " +
        "e2e against a deployed playground. Run under the env's Doppler config.",
    );
  }
  const base = {
    forgePrivateJwk,
    issuer: `${env.authBaseUrl}/api/auth`,
    email: "streams-e2e@iterate.com",
    admin: true,
  };
  return {
    accessToken: await mintForgedAccessToken({
      ...base,
      audience: new URL(env.baseUrl).origin,
    }),
    idToken: await mintForgedIdToken({ ...base, clientId }),
  };
}

// CLI: print an admin access token for the deployed WORKER_URL (empty on
// local dev). The preview e2e lane exports it as STREAMS_PLAYGROUND_TOKEN.
if (process.argv[1]?.endsWith("auth.ts")) {
  const token = await mintAdminAccessToken(process.env.WORKER_URL);
  console.log(token ?? "");
}
