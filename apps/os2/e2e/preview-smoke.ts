function requireBaseUrl() {
  const baseUrl = process.env.OS2_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Error("OS2_BASE_URL is required for the OS2 preview smoke test.");
  }
  return new URL(baseUrl);
}

function readProjectMcpUrlOverride() {
  const url = process.env.OS2_PROJECT_MCP_URL?.trim();
  return url ? new URL(url) : null;
}

function readAdminApiSecret() {
  return (
    process.env.OS2_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
    null
  );
}

async function expectStatus(input: { method?: string; status: number; url: URL }) {
  const response = await fetch(input.url, {
    method: input.method ?? "GET",
    redirect: "manual",
  });
  if (response.status !== input.status) {
    throw new Error(`Expected ${input.status} from ${input.url}; received ${response.status}.`);
  }
  return response;
}

async function seedProjectMcpUrl(input: { adminApiSecret: string; baseUrl: URL }) {
  const response = await fetch(new URL("/api/projects/seed-mcp-project", input.baseUrl), {
    body: JSON.stringify({
      projectId: "proj-preview-mcp-smoke",
      slug: "preview-mcp-smoke",
    }),
    headers: {
      authorization: `Bearer ${input.adminApiSecret}`,
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      `Failed to seed MCP smoke project at ${input.baseUrl}: ${response.status} ${await response.text()}`,
    );
  }

  const body = (await response.json()) as { mcpUrl?: string };
  if (!body.mcpUrl) {
    throw new Error(`Seed MCP response did not include mcpUrl: ${JSON.stringify(body)}`);
  }
  return new URL(body.mcpUrl);
}

const baseUrl = requireBaseUrl();
const projectMcpUrlOverride = readProjectMcpUrlOverride();
const adminApiSecret = readAdminApiSecret();

// Keep the dashboard checks unauthenticated, then use the admin preview hook to
// seed one deterministic project/MCP hostname. That makes the preview proof
// repeatable without relying on a human Clerk session.
await expectStatus({
  url: new URL("/api/__internal/health", baseUrl),
  status: 200,
});

const rootResponse = await expectStatus({
  url: new URL("/", baseUrl),
  status: 307,
});
const rootLocation = rootResponse.headers.get("location") ?? "";
if (!rootLocation.startsWith("/sign-in?redirect_url=")) {
  throw new Error(`Expected unauthenticated root to redirect to sign-in; got ${rootLocation}.`);
}

const projectMcpUrl =
  projectMcpUrlOverride ??
  (adminApiSecret ? await seedProjectMcpUrl({ adminApiSecret, baseUrl }) : null);

if (!projectMcpUrl) {
  console.log(`OS2 preview smoke passed for ${baseUrl.toString()} (MCP project seed skipped)`);
  process.exit(0);
}

const instructionsResponse = await fetch(projectMcpUrl, {
  headers: { accept: "text/html" },
  redirect: "manual",
});
if (!instructionsResponse.ok) {
  throw new Error(
    `Expected MCP instructions page from ${projectMcpUrl}; received ${instructionsResponse.status}.`,
  );
}
const instructionsHtml = await instructionsResponse.text();
if (!instructionsHtml.includes("Connect an MCP client to this project endpoint")) {
  throw new Error(`MCP instructions page did not contain setup text: ${instructionsHtml}`);
}

const projectMcpResponse = await expectStatus({
  url: projectMcpUrl,
  status: 401,
});
const wwwAuthenticate = projectMcpResponse.headers.get("www-authenticate") ?? "";
const metadataUrl = new URL("/.well-known/oauth-protected-resource", projectMcpUrl.origin);
if (!wwwAuthenticate.includes(`resource_metadata="${metadataUrl.toString()}"`)) {
  throw new Error(`Unexpected MCP WWW-Authenticate header: ${wwwAuthenticate}`);
}

const metadataResponse = await expectStatus({
  url: metadataUrl,
  status: 200,
});
const metadata = (await metadataResponse.json()) as { resource?: string };
if (metadata.resource !== projectMcpUrl.toString()) {
  throw new Error(`Expected MCP metadata resource ${projectMcpUrl}; got ${metadata.resource}.`);
}

console.log(`OS2 preview smoke passed for ${baseUrl.toString()}`);

export {};
