/**
 * Provision semaphore-prd's relying-party credentials — the prd counterpart
 * of `pnpm preview provision-auth-preview-configs` (which handles the preview
 * slots). Idempotent; run it before deploying a semaphore that requires
 * iterate auth:
 *
 *   doppler run --project auth --config prd -- pnpm --dir apps/semaphore tsx scripts/sync-auth-client.ts
 *
 * It ensures, in order:
 *   1. an OAuth client on the prd auth worker (browser sign-in for
 *      semaphore.iterate.com), mirrored into AUTH_SEED_OAUTH_CLIENTS so auth
 *      redeploys keep it;
 *   2. APP_CONFIG_ITERATE_AUTH__CLIENT_ID/SECRET in semaphore/prd Doppler;
 *   3. the forge key in semaphore/prd (deploys bake its public half into the
 *      worker's JWKS) and in _shared/prd (the preview CLI mints admin bearer
 *      tokens with it) — copied from os/prd together with
 *      AUTH_FORGE_ALLOW_PRODUCTION, the deliberate production-minting opt-in
 *      os already made (#1499).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createAuthContractClient } from "@iterate-com/auth-contract";
import { semaphoreEnvs } from "../../../envs.ts";

type SeedOAuthClientSpec = {
  clientId: string;
  clientSecret: string;
  clientName: string;
  redirectURIs: string[];
  referenceId?: string;
  skipConsent?: boolean;
};

const env = semaphoreEnvs.prd;
const authIssuer = `${env.authBaseUrl}/api/auth`;
const serviceToken = process.env.APP_CONFIG_SERVICE_AUTH_TOKEN?.trim();
if (!serviceToken) {
  throw new Error(
    "APP_CONFIG_SERVICE_AUTH_TOKEN is required. Run through Doppler for auth prd: " +
      "doppler run --project auth --config prd -- pnpm --dir apps/semaphore tsx scripts/sync-auth-client.ts",
  );
}

const authClient = createAuthContractClient({ baseUrl: env.authBaseUrl, serviceToken });

const referenceId = "semaphore:prd:web";
const clientName = "Semaphore prd web";
const redirectURIs = [`${env.baseUrl}/api/iterate-auth/callback`];
const client = await authClient.internal.oauth.ensureClient({
  referenceId,
  clientName,
  redirectURIs,
  existingClientId: getDopplerSecret("semaphore", "prd", "APP_CONFIG_ITERATE_AUTH__CLIENT_ID"),
  existingClientSecret: getDopplerSecret(
    "semaphore",
    "prd",
    "APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET",
  ),
});

setDopplerSecrets("semaphore", "prd", {
  APP_CONFIG_ITERATE_AUTH__CLIENT_ID: client.clientId,
  APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET: client.clientSecret,
});
console.log(`semaphore/prd OAuth client ensured (${client.clientId})`);

upsertAuthSeedOAuthClient({
  clientId: client.clientId,
  clientSecret: client.clientSecret,
  clientName,
  redirectURIs,
  referenceId,
  skipConsent: true,
});

const forgePrivateJwk = getDopplerSecret("os", "prd", "AUTH_FORGE_PRIVATE_JWK");
const allowProduction = getDopplerSecret("os", "prd", "AUTH_FORGE_ALLOW_PRODUCTION");
if (!forgePrivateJwk || !allowProduction) {
  throw new Error(
    "os/prd is missing AUTH_FORGE_PRIVATE_JWK or AUTH_FORGE_ALLOW_PRODUCTION — cannot mirror the forge key.",
  );
}
setDopplerSecrets("semaphore", "prd", {
  AUTH_FORGE_PRIVATE_JWK: forgePrivateJwk,
  AUTH_FORGE_ALLOW_PRODUCTION: allowProduction,
});
setDopplerSecrets("_shared", "prd", { AUTH_FORGE_PRIVATE_JWK: forgePrivateJwk });
console.log("forge key mirrored into semaphore/prd and _shared/prd");
console.log(`done — issuer ${authIssuer}`);

function getDopplerSecret(project: string, config: string, name: string) {
  try {
    const value = execFileSync(
      "doppler",
      ["secrets", "get", name, "--plain", "--project", project, "--config", config],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function setDopplerSecrets(project: string, config: string, secrets: Record<string, string>) {
  for (const [key, value] of Object.entries(secrets)) {
    const result = spawnSync(
      "doppler",
      ["secrets", "set", key, "--project", project, "--config", config, "--no-interactive"],
      { input: value, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.status !== 0) {
      throw new Error(
        `Failed to set ${key} for ${project}/${config}: ${result.stderr || result.stdout}`,
      );
    }
  }
}

function upsertAuthSeedOAuthClient(client: SeedOAuthClientSpec) {
  const raw = getDopplerSecret("auth", "prd", "AUTH_SEED_OAUTH_CLIENTS");
  const clients: SeedOAuthClientSpec[] = raw ? (JSON.parse(raw) as SeedOAuthClientSpec[]) : [];
  const index = clients.findIndex(
    (candidate) =>
      candidate.referenceId === client.referenceId || candidate.clientId === client.clientId,
  );
  if (index === -1) clients.push(client);
  else clients[index] = client;
  clients.sort((a, b) => (a.referenceId ?? a.clientId).localeCompare(b.referenceId ?? b.clientId));
  setDopplerSecrets("auth", "prd", { AUTH_SEED_OAUTH_CLIENTS: JSON.stringify(clients) });
  console.log("auth/prd AUTH_SEED_OAUTH_CLIENTS updated");
}
