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

type JsonWebKeySet = {
  keys: unknown[];
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

const authIssuer = process.env.ITERATE_OAUTH_ISSUER?.trim() || "https://auth.iterate.com/api/auth";
const authBaseUrl =
  process.env.AUTH_BASE_URL?.trim() ||
  process.env.VITE_AUTH_APP_ORIGIN?.trim() ||
  new URL(authIssuer).origin;
const serviceToken = process.env.SERVICE_AUTH_TOKEN?.trim();
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
    "SERVICE_AUTH_TOKEN is required. Run through Doppler for auth prd, for example: doppler run --project auth --config prd -- pnpm --dir apps/os tsx scripts/sync-auth-clients.ts",
  );
}

const authClient = createAuthContractClient({ baseUrl: authBaseUrl, serviceToken });
const seedOAuthClients = readSeedOAuthClients();
const authJwks = await fetchAuthJwks();

for (const target of targets) {
  if (targetFilter.size > 0 && !targetFilter.has(target.dopplerConfig)) {
    continue;
  }

  const webRedirectUri = `${target.baseUrl}/api/iterate-auth/callback`;
  const webReferenceId = `os:${target.dopplerConfig}:web`;
  const webClientName = `OS ${target.dopplerConfig} web`;
  const existingWebClientId = getDopplerSecret(target, "ITERATE_OAUTH_CLIENT_ID");
  const existingWebClientSecret = getDopplerSecret(target, "ITERATE_OAUTH_CLIENT_SECRET");
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
  const existingMcpClientId = getDopplerSecret(target, "ITERATE_MCP_OAUTH_CLIENT_ID");
  const existingMcpClientSecret = getDopplerSecret(target, "ITERATE_MCP_OAUTH_CLIENT_SECRET");
  const mcpClient = await authClient.internal.oauth.ensureClient({
    referenceId: mcpReferenceId,
    clientName: mcpClientName,
    redirectURIs: mcpRedirectURIs,
    existingClientId: existingMcpClientId,
    existingClientSecret: existingMcpClientSecret,
    rotateClientSecret: rotateClientSecrets,
  });

  setDopplerSecrets(target, {
    APP_CONFIG_BASE_URL: target.baseUrl,
    APP_CONFIG_MCP__BASE_URL: target.mcpBaseUrl,
    APP_CONFIG_PROJECT_HOSTNAME_BASES: JSON.stringify([target.projectHostnameBase]),
    ITERATE_OAUTH_ISSUER: authIssuer,
    ITERATE_OAUTH_CLIENT_ID: webClient.clientId,
    ITERATE_OAUTH_CLIENT_SECRET: webClient.clientSecret,
    ITERATE_OAUTH_REDIRECT_URI: webRedirectUri,
    ITERATE_MCP_OAUTH_CLIENT_ID: mcpClient.clientId,
    ITERATE_MCP_OAUTH_CLIENT_SECRET: mcpClient.clientSecret,
    ITERATE_AUTH_SERVICE_TOKEN: serviceToken,
    ITERATE_AUTH_JWKS: JSON.stringify(authJwks),
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

async function fetchAuthJwks(): Promise<JsonWebKeySet> {
  const jwksUrl = `${authIssuer.replace(/\/+$/, "")}/jwks`;
  let response: Response;
  try {
    response = await fetch(jwksUrl, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new Error(`Failed to fetch auth JWKS from ${jwksUrl}`, { cause });
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch auth JWKS from ${jwksUrl}: HTTP ${response.status}`);
  }

  const parsed = (await response.json()) as unknown;
  if (!isJsonWebKeySet(parsed)) {
    throw new Error(`Auth JWKS from ${jwksUrl} must be a JSON object with a non-empty keys array`);
  }

  return parsed;
}

function isJsonWebKeySet(value: unknown): value is JsonWebKeySet {
  return (
    typeof value === "object" &&
    value !== null &&
    "keys" in value &&
    Array.isArray(value.keys) &&
    value.keys.length > 0
  );
}

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
