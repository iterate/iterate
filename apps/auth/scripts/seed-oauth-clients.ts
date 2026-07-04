import { z } from "zod/v4";
import { createAuthContractClient } from "@iterate-com/auth-contract";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";

// Declarative OAuth client seeding: Doppler is the source of truth.
//
// `AUTH_SEED_OAUTH_CLIENTS` holds a JSON array of client specs (id + secret +
// redirect URIs as constants). After every auth deploy this script upserts
// exactly those clients into the deployment's database via the service-token
// authenticated `internal.oauth.setClient` endpoint. Idempotent: re-running
// with the same Doppler values is a no-op, and nothing ever rotates a seeded
// client — so the credentials in Doppler can never drift from the database.
//
// Runs automatically from apps/auth/scripts/deploy.ts after a deploy,
// and standalone against any environment:
//
//   doppler run --project auth --config dev_global -- pnpm seed-oauth-clients
//   doppler run --project auth --config preview_3 -- pnpm seed-oauth-clients

export const SeedOAuthClientSpec = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(16),
  clientName: z.string().min(1),
  redirectURIs: z.array(z.url()).min(1),
  referenceId: z.string().min(1).optional(),
  skipConsent: z.boolean().optional(),
});
export type SeedOAuthClientSpec = z.infer<typeof SeedOAuthClientSpec>;

const OptionalNonEmptyString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const OptionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.url().optional(),
);

export const SeedOAuthClientsEnv = z
  .object({
    AUTH_SEED_OAUTH_CLIENTS: z
      .string()
      .transform((value, ctx) => {
        try {
          return JSON.parse(value) as unknown;
        } catch (error) {
          ctx.addIssue({ code: "custom", message: `not valid JSON: ${error}` });
          return z.NEVER;
        }
      })
      .pipe(z.array(SeedOAuthClientSpec)),
    APP_CONFIG_SERVICE_AUTH_TOKEN: OptionalNonEmptyString,
    // The deployed auth origin to seed, e.g. https://auth.iterate-dev.com.
    APP_CONFIG_AUTH_APP_ORIGIN: OptionalUrl,
  })
  .transform((env, ctx) => {
    const serviceAuthToken = env.APP_CONFIG_SERVICE_AUTH_TOKEN;
    if (!serviceAuthToken) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_CONFIG_SERVICE_AUTH_TOKEN"],
        message: "APP_CONFIG_SERVICE_AUTH_TOKEN is required",
      });
      return z.NEVER;
    }

    const authAppOrigin = env.APP_CONFIG_AUTH_APP_ORIGIN;
    if (!authAppOrigin) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_CONFIG_AUTH_APP_ORIGIN"],
        message: "APP_CONFIG_AUTH_APP_ORIGIN is required",
      });
      return z.NEVER;
    }

    return {
      authAppOrigin,
      clients: env.AUTH_SEED_OAUTH_CLIENTS,
      serviceAuthToken,
    };
  });

async function waitForAuthDeployment(baseUrl: string, timeoutMs = 120_000) {
  const discoveryUrl = `${baseUrl.replace(/\/+$/, "")}/api/auth/.well-known/openid-configuration`;
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(discoveryUrl, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`Auth deployment at ${discoveryUrl} not reachable: ${lastError}`);
}

export async function seedOAuthClients(
  env: Record<string, string | undefined>,
  // The reachable URL to seed *through* (API calls + readiness probe). Defaults
  // to the configured auth app origin. The seeded data (redirect URIs) is
  // unaffected by which deployed origin handles the admin request.
  opts: { baseUrl?: string } = {},
) {
  const parsed = SeedOAuthClientsEnv.safeParse(env);
  if (!parsed.success) {
    throw new Error(`seed-oauth-clients env invalid: ${z.prettifyError(parsed.error)}`);
  }
  const { authAppOrigin, clients, serviceAuthToken } = parsed.data;
  const seedThroughUrl = opts.baseUrl?.trim() || authAppOrigin;

  await waitForAuthDeployment(seedThroughUrl);

  const authClient = createAuthContractClient({
    baseUrl: seedThroughUrl,
    serviceToken: serviceAuthToken,
  });

  for (const spec of clients) {
    const result = await authClient.internal.oauth.setClient({
      clientId: spec.clientId,
      clientSecret: spec.clientSecret,
      clientName: spec.clientName,
      redirectURIs: spec.redirectURIs,
      referenceId: spec.referenceId,
      skipConsent: spec.skipConsent,
    });
    console.log(
      `[seed-oauth-clients] ensured client "${result.clientId}" (${result.clientName}) ` +
        `redirectURIs=${JSON.stringify(result.redirectURIs)}`,
    );
  }

  console.log(
    `[seed-oauth-clients] done: ${clients.length} client(s) seeded via ${seedThroughUrl}`,
  );
}

if (isMainModule(import.meta.url)) {
  if (!process.env.AUTH_SEED_OAUTH_CLIENTS) {
    console.log("[seed-oauth-clients] AUTH_SEED_OAUTH_CLIENTS not set; nothing to seed.");
    process.exit(0);
  }
  await seedOAuthClients(process.env);
}
