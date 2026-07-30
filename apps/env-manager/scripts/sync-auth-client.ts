/**
 * Provision env-manager's production Auth relying-party credentials.
 *
 * Run through Auth's production Doppler config:
 *
 *   doppler run --project auth --config prd -- \
 *     pnpm --dir apps/env-manager sync-auth-client
 *
 * The Auth database creates or adopts the client through ensureClient, the
 * resulting credentials are written to env-manager/prd, and the same client
 * is mirrored into auth/prd's deploy-time OAuth seed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createAuthContractClient } from "@iterate-com/auth-contract";
import { envManagerEnv } from "../../../envs.ts";

type SeedOAuthClientSpec = {
  clientId: string;
  clientSecret: string;
  clientName: string;
  redirectURIs: string[];
  referenceId?: string;
  skipConsent?: boolean;
};

const serviceToken = process.env.APP_CONFIG_SERVICE_AUTH_TOKEN?.trim();
if (!serviceToken) {
  throw new Error(
    "APP_CONFIG_SERVICE_AUTH_TOKEN is required. Run through Doppler for auth prd: " +
      "doppler run --project auth --config prd -- pnpm --dir apps/env-manager sync-auth-client",
  );
}

const referenceId = "env-manager:prd:web";
const clientName = "Environment manager prd web";
const redirectURIs = [`${envManagerEnv.baseUrl}/api/iterate-auth/callback`];
const authClient = createAuthContractClient({
  baseUrl: envManagerEnv.authBaseUrl,
  serviceToken,
});
const client = await authClient.internal.oauth.ensureClient({
  referenceId,
  clientName,
  redirectURIs,
  existingClientId: getDopplerSecret(
    "env-manager",
    envManagerEnv.dopplerConfig,
    "APP_CONFIG_ITERATE_AUTH__CLIENT_ID",
  ),
  existingClientSecret: getDopplerSecret(
    "env-manager",
    envManagerEnv.dopplerConfig,
    "APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET",
  ),
});

setDopplerSecrets("env-manager", envManagerEnv.dopplerConfig, {
  APP_CONFIG_ITERATE_AUTH__CLIENT_ID: client.clientId,
  APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET: client.clientSecret,
});
console.log(`env-manager/prd OAuth client ensured (${client.clientId})`);

upsertAuthSeedOAuthClient({
  clientId: client.clientId,
  clientSecret: client.clientSecret,
  clientName,
  redirectURIs,
  referenceId,
  skipConsent: true,
});

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
