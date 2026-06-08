import { execFileSync, spawnSync } from "node:child_process";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { SERVICE_TOKEN_HEADER, type AuthContractClient } from "@iterate-com/auth-contract";

type Target = {
  dopplerConfig: string;
  baseUrl: string;
  mcpBaseUrl: string;
  projectHostnameBase: string;
};

const targets: Target[] = [
  {
    dopplerConfig: "dev_jonas",
    baseUrl: "https://os.iterate-dev-jonas.com",
    mcpBaseUrl: "https://mcp.iterate-dev-jonas.com",
    projectHostnameBase: "iterate-dev-jonas.app",
  },
  {
    dopplerConfig: "dev_misha",
    baseUrl: "https://os.iterate-dev-misha.com",
    mcpBaseUrl: "https://mcp.iterate-dev-misha.com",
    projectHostnameBase: "iterate-dev-misha.app",
  },
  {
    dopplerConfig: "dev_rahul",
    baseUrl: "https://os.iterate-dev-rahul.com",
    mcpBaseUrl: "https://mcp.iterate-dev-rahul.com",
    projectHostnameBase: "iterate-dev-rahul.app",
  },
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

const authClient = createORPCClient(
  new RPCLink({
    url: `${authBaseUrl.replace(/\/+$/, "")}/api/orpc/`,
    fetch: (request: URL | Request, init?: RequestInit) => {
      const headers = new Headers(request instanceof Request ? request.headers : init?.headers);
      headers.set(SERVICE_TOKEN_HEADER, serviceToken);
      return fetch(request, { ...init, headers });
    },
  }),
) as AuthContractClient;

for (const target of targets) {
  if (targetFilter.size > 0 && !targetFilter.has(target.dopplerConfig)) {
    continue;
  }

  const webRedirectUri = `${target.baseUrl}/api/iterate-auth/callback`;
  const existingWebClientId = getDopplerSecret(target, "ITERATE_OAUTH_CLIENT_ID");
  const existingWebClientSecret = getDopplerSecret(target, "ITERATE_OAUTH_CLIENT_SECRET");
  const webClient = await authClient.internal.oauth.ensureClient({
    referenceId: `os:${target.dopplerConfig}:web`,
    clientName: `OS ${target.dopplerConfig} web`,
    redirectURIs: [webRedirectUri],
    existingClientId: existingWebClientId,
    existingClientSecret: existingWebClientSecret,
    rotateClientSecret: rotateClientSecrets,
  });

  const existingMcpClientId = getDopplerSecret(target, "ITERATE_MCP_OAUTH_CLIENT_ID");
  const existingMcpClientSecret = getDopplerSecret(target, "ITERATE_MCP_OAUTH_CLIENT_SECRET");
  const mcpClient = await authClient.internal.oauth.ensureClient({
    referenceId: `os:${target.dopplerConfig}:mcp`,
    clientName: `OS ${target.dopplerConfig} MCP`,
    redirectURIs: [
      "http://127.0.0.1/callback",
      "http://localhost/callback",
      "http://127.0.0.1:3334/callback",
      "http://localhost:3334/callback",
    ],
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
  });

  console.log(`synced auth clients for ${target.dopplerConfig}`);
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
