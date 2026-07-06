/**
 * Deploy-time JWKS baking for relying-party workers (apps/os, apps/semaphore).
 *
 * A static JWKS lets a worker verify auth JWTs without a runtime fetch, and
 * is the only trustworthy carrier for the forge public key (identity minting
 * — scripts/auth/mint-session.ts). An explicit APP_CONFIG_ITERATE_AUTH__JWKS
 * in Doppler wins over the live fetch — the break-glass path for deploying
 * while the auth worker is down. Forge keys in production-serving configs
 * require the explicit AUTH_FORGE_ALLOW_PRODUCTION opt-in.
 */
export async function bakeStaticAuthJwks(input: {
  /** The env's auth worker origin, e.g. https://auth.iterate.com */
  authBaseUrl: string;
  /** The env name from envs.ts, e.g. "prd" or "preview_3" (for error messages and the prod gate). */
  envName: string;
  /** The env's Doppler config name (for error messages). */
  dopplerConfig: string;
  /** The env's full Doppler secret map (reads the pinned JWKS and forge key). */
  secrets: Record<string, string | undefined>;
}): Promise<string> {
  const issuer = `${input.authBaseUrl}/api/auth`;

  const pinned = input.secrets.APP_CONFIG_ITERATE_AUTH__JWKS?.trim();
  if (pinned) {
    console.warn(
      `Using the JWKS pinned in Doppler (APP_CONFIG_ITERATE_AUTH__JWKS) instead of fetching ${issuer}/jwks.`,
    );
  }
  const jwks = pinned
    ? (JSON.parse(pinned) as { keys: Record<string, unknown>[] })
    : await fetchJwksWithRetry(`${issuer}/jwks`, input.envName);

  const forgePrivateJwk = input.secrets.AUTH_FORGE_PRIVATE_JWK?.trim();
  if (forgePrivateJwk) {
    const isProdServing = input.envName === "prd" || issuer.includes("auth.iterate.com");
    const allowProduction = /^(1|true|yes)$/i.test(input.secrets.AUTH_FORGE_ALLOW_PRODUCTION ?? "");
    if (isProdServing && !allowProduction) {
      throw new Error(
        `AUTH_FORGE_PRIVATE_JWK is present in ${input.dopplerConfig} (production-serving) without ` +
          "AUTH_FORGE_ALLOW_PRODUCTION=true. Set the flag to deliberately enable production minting, " +
          "or remove the forge key.",
      );
    }
    const { d: _privateKey, ...publicJwk } = JSON.parse(forgePrivateJwk) as Record<
      string,
      unknown
    > & { d?: string };
    if (!publicJwk.kid || !publicJwk.kty)
      throw new Error("AUTH_FORGE_PRIVATE_JWK must be a JWK with kid and kty");
    if (!jwks.keys.some((key) => key.kid === publicJwk.kid)) jwks.keys.push(publicJwk);
  }
  return JSON.stringify(jwks);
}

/**
 * Poll the issuer's JWKS for up to ~4 minutes: the preview CI lane deploys
 * auth and its relying parties IN PARALLEL, so this env's auth worker may
 * legitimately still be mid-deploy (migrations + build take minutes) when a
 * relying party gets here.
 */
async function fetchJwksWithRetry(url: string, envName: string) {
  const deadline = Date.now() + 4 * 60_000;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { keys?: Record<string, unknown>[] };
      if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error("JWKS has no keys");
      return body as { keys: Record<string, unknown>[] };
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(
          `Deploy-time JWKS fetch from ${url} kept failing for 4 minutes (last: ${error}). ` +
            `Deploy the auth worker for ${envName} first, or pin APP_CONFIG_ITERATE_AUTH__JWKS in Doppler.`,
        );
      }
      console.warn(
        `JWKS fetch attempt ${attempt} failed (${error}); auth may still be deploying — retrying…`,
      );
      await new Promise((res) => setTimeout(res, Math.min(2000 * attempt, 10_000)));
    }
  }
}
