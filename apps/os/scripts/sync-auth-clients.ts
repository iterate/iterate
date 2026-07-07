import { execFileSync, spawnSync } from "node:child_process";
import { createAuthContractClient } from "@iterate-com/auth-contract";

type Target = {
  dopplerConfig: string;
  baseUrl: string;
  mcpBaseUrl: string;
  projectHostnameBase: string;
};

type SeedOAuthClientSpec = {
  clientId: string;
  clientSecret: string;
  clientName: string;
  redirectURIs: string[];
  referenceId?: string;
};

const targets: Target[] = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(
    (previewNumber) =>
      ({
        dopplerConfig: `preview_${previewNumber}`,
        baseUrl: `https://os.iterate-preview-${previewNumber}.com`,
        mcpBaseUrl: `https://mcp.iterate-preview-${previewNumber}.com`,
        projectHostnameBase: `iterate-preview-${previewNumber}.app`,
      }) satisfies Target,
  ),
  {
    dopplerConfig: "prd",
    baseUrl: "https://os.iterate.com",
    mcpBaseUrl: "https://mcp.iterate.com",
    projectHostnameBase: "iterate.app",
  },
];

const configuredAuthOrigin = process.env.APP_CONFIG_AUTH_APP_ORIGIN?.trim();
const authIssuer = configuredAuthOrigin
  ? `${configuredAuthOrigin.replace(/\/+$/, "")}/api/auth`
  : "https://auth.iterate.com/api/auth";
const authBaseUrl =
  process.env.AUTH_BASE_URL?.trim() ||
  process.env.APP_CONFIG_AUTH_APP_ORIGIN?.trim() ||
  new URL(authIssuer).origin;
const serviceToken = process.env.APP_CONFIG_SERVICE_AUTH_TOKEN?.trim();
const authDopplerProject = process.env.DOPPLER_PROJECT?.trim() || "auth";
const authDopplerConfig = process.env.DOPPLER_CONFIG?.trim() || "prd";
const targetFilter = new Set(
  (process.env.AUTH_CLIENT_SYNC_TARGETS ?? "")
    .split(",")
    .map((target) => target.trim())
    .filter(Boolean),
);
const rotateClientSecrets = process.env.ROTATE_AUTH_CLIENT_SECRETS === "1";

if (!serviceToken) {
  throw new Error(
    "APP_CONFIG_SERVICE_AUTH_TOKEN is required. Run through Doppler for auth prd, for example: doppler run --project auth --config prd -- pnpm --dir apps/os tsx scripts/sync-auth-clients.ts",
  );
}

const authClient = createAuthContractClient({ baseUrl: authBaseUrl, serviceToken });
const seedOAuthClients = readSeedOAuthClients();

for (const target of targets) {
  if (targetFilter.size > 0 && !targetFilter.has(target.dopplerConfig)) {
    continue;
  }

  const webRedirectUri = `${target.baseUrl}/api/iterate-auth/callback`;
  const webReferenceId = `os:${target.dopplerConfig}:web`;
  const webClientName = `OS ${target.dopplerConfig} web`;
  const existingWebClientId = getDopplerSecret(target, "APP_CONFIG_ITERATE_AUTH__CLIENT_ID");
  const existingWebClientSecret = getDopplerSecret(
    target,
    "APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET",
  );
  const webClient = await authClient.internal.oauth.ensureClient({
    referenceId: webReferenceId,
    clientName: webClientName,
    redirectURIs: [webRedirectUri],
    existingClientId: existingWebClientId,
    existingClientSecret: existingWebClientSecret,
    rotateClientSecret: rotateClientSecrets,
  });

  const mcpReferenceId = `os:${target.dopplerConfig}:mcp`;
  const mcpClientName = `OS ${target.dopplerConfig} MCP`;
  const mcpRedirectURIs = [
    "http://127.0.0.1/callback",
    "http://localhost/callback",
    "http://127.0.0.1:3334/callback",
    "http://localhost:3334/callback",
  ];
  const existingMcpSeed = seedOAuthClients.find(
    (candidate) => candidate.referenceId === mcpReferenceId,
  );
  const mcpClient = await authClient.internal.oauth.ensureClient({
    referenceId: mcpReferenceId,
    clientName: mcpClientName,
    redirectURIs: mcpRedirectURIs,
    existingClientId: existingMcpSeed?.clientId,
    existingClientSecret: existingMcpSeed?.clientSecret,
    rotateClientSecret: rotateClientSecrets,
  });

  setDopplerSecrets(target, {
    APP_CONFIG_BASE_URL: target.baseUrl,
    APP_CONFIG_MCP__BASE_URL: target.mcpBaseUrl,
    APP_CONFIG_PROJECT_HOSTNAME_BASES: JSON.stringify([target.projectHostnameBase]),
    APP_CONFIG_ITERATE_AUTH__ISSUER: authIssuer,
    APP_CONFIG_ITERATE_AUTH__CLIENT_ID: webClient.clientId,
    APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET: webClient.clientSecret,
    APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN: serviceToken,
  });

  upsertSeedOAuthClient(seedOAuthClients, {
    clientId: webClient.clientId,
    clientSecret: webClient.clientSecret,
    clientName: webClientName,
    redirectURIs: [webRedirectUri],
    referenceId: webReferenceId,
  });
  upsertSeedOAuthClient(seedOAuthClients, {
    clientId: mcpClient.clientId,
    clientSecret: mcpClient.clientSecret,
    clientName: mcpClientName,
    redirectURIs: mcpRedirectURIs,
    referenceId: mcpReferenceId,
  });

  console.log(`synced auth clients for ${target.dopplerConfig}`);
}

setAuthSeedOAuthClients(seedOAuthClients);

function getDopplerSecret(target: Target, key: string) {
  try {
    const value = execFileSync(
      "doppler",
      ["secrets", "get", key, "--plain", "--project", "os", "--config", target.dopplerConfig],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function readSeedOAuthClients() {
  const result = spawnSync(
    "doppler",
    [
      "secrets",
      "get",
      "AUTH_SEED_OAUTH_CLIENTS",
      "--plain",
      "--project",
      authDopplerProject,
      "--config",
      authDopplerConfig,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  if (result.status !== 0) {
    const output = `${result.stderr}\n${result.stdout}`;
    if (
      /not found|does not exist|not exist|not set|could not find requested secret/i.test(output)
    ) {
      return [];
    }
    throw new Error(
      `Failed to read AUTH_SEED_OAUTH_CLIENTS for ${authDopplerProject}/${authDopplerConfig}: ${output}`,
    );
  }

  const value = result.stdout.trim();
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed as SeedOAuthClientSpec[];
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`AUTH_SEED_OAUTH_CLIENTS is not valid JSON: ${error.message}`);
    }
    throw error;
  }
  throw new Error("AUTH_SEED_OAUTH_CLIENTS must be a JSON array");
}

function upsertSeedOAuthClient(clients: SeedOAuthClientSpec[], client: SeedOAuthClientSpec) {
  const index = clients.findIndex(
    (candidate) =>
      candidate.referenceId === client.referenceId || candidate.clientId === client.clientId,
  );
  if (index === -1) {
    clients.push(client);
  } else {
    clients[index] = client;
  }
  clients.sort((a, b) => (a.referenceId ?? a.clientId).localeCompare(b.referenceId ?? b.clientId));
}

function setAuthSeedOAuthClients(clients: SeedOAuthClientSpec[]) {
  const result = spawnSync(
    "doppler",
    [
      "secrets",
      "set",
      "AUTH_SEED_OAUTH_CLIENTS",
      "--project",
      authDopplerProject,
      "--config",
      authDopplerConfig,
      "--no-interactive",
    ],
    {
      input: JSON.stringify(clients),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `Failed to set AUTH_SEED_OAUTH_CLIENTS for ${authDopplerProject}/${authDopplerConfig}: ${
        result.stderr || result.stdout
      }`,
    );
  }
  console.log(`updated AUTH_SEED_OAUTH_CLIENTS for ${authDopplerProject}/${authDopplerConfig}`);
}

function setDopplerSecrets(target: Target, secrets: Record<string, string>) {
  for (const [key, value] of Object.entries(secrets)) {
    const result = spawnSync(
      "doppler",
      [
        "secrets",
        "set",
        key,
        "--project",
        "os",
        "--config",
        target.dopplerConfig,
        "--no-interactive",
      ],
      {
        input: value,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    if (result.status !== 0) {
      throw new Error(
        `Failed to set ${key} for ${target.dopplerConfig}: ${result.stderr || result.stdout}`,
      );
    }
  }
}
