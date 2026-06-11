import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import { createAuthContractClient } from "@iterate-com/auth-contract";

// Declarative OAuth client seeding: Doppler is the source of truth.
//
// `AUTH_SEED_OAUTH_CLIENTS` holds a JSON array of client specs (id + secret +
// redirect URIs as constants). After every auth deploy this script upserts
// exactly those clients into the deployment's database via the service-token
// authenticated `internal.oauth.setClient` endpoint. Idempotent: re-running
// with the same Doppler values is a no-op, and nothing ever rotates a seeded
// client — so the credentials in Doppler can never drift from the database.
//
// Runs automatically from apps/auth/alchemy.run.ts after a (non-local) deploy,
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

export const SeedOAuthClientsEnv = z.object({
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
  SERVICE_AUTH_TOKEN: z.string().min(1),
  // The deployed auth origin to seed, e.g. https://auth.iterate-dev.com.
  VITE_AUTH_APP_ORIGIN: z.url(),
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

export async function seedOAuthClients(env: Record<string, string | undefined>) {
  const parsed = SeedOAuthClientsEnv.safeParse(env);
  if (!parsed.success) {
    throw new Error(`seed-oauth-clients env invalid: ${z.prettifyError(parsed.error)}`);
  }
  const {
    AUTH_SEED_OAUTH_CLIENTS: clients,
    SERVICE_AUTH_TOKEN,
    VITE_AUTH_APP_ORIGIN,
  } = parsed.data;

  await waitForAuthDeployment(VITE_AUTH_APP_ORIGIN);

  const authClient = createAuthContractClient({
    baseUrl: VITE_AUTH_APP_ORIGIN,
    serviceToken: SERVICE_AUTH_TOKEN,
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
    `[seed-oauth-clients] done: ${clients.length} client(s) seeded into ${VITE_AUTH_APP_ORIGIN}`,
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  if (!process.env.AUTH_SEED_OAUTH_CLIENTS) {
    console.log("[seed-oauth-clients] AUTH_SEED_OAUTH_CLIENTS not set; nothing to seed.");
    process.exit(0);
  }
  await seedOAuthClients(process.env);
}
