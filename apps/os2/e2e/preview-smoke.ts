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

function projectMcpUrlFor(baseUrl: URL, projectMcpUrlOverride: URL | null) {
  if (projectMcpUrlOverride) return projectMcpUrlOverride;

  const previewMatch = /^os2\.iterate-preview-(\d+)\.com$/.exec(baseUrl.hostname);
  if (previewMatch) {
    return new URL(`https://mcp__demo.iterate-preview-${previewMatch[1]}.app/`);
  }

  const dashboardPrefix = "os.";
  if (!baseUrl.hostname.startsWith(dashboardPrefix)) {
    throw new Error(
      `OS2 preview base URL must be os2.iterate-preview-N.com or start with os.; received ${baseUrl.hostname}.`,
    );
  }
  const projectHostnameBase = baseUrl.hostname
    .slice(dashboardPrefix.length)
    // OS2 dashboard hosts use `.com` for the app shell while project/MCP hosts
    // use `.app` for user code and OAuth resource URLs. Keep the smoke test's
    // fallback derivation aligned with the deployed dev/prod host contract. Use
    // the single-label MCP host because wildcard certificates cover it in
    // preview, and allow OS2_PROJECT_MCP_URL above for any future topology that cannot be
    // inferred from OS2_BASE_URL alone.
    .replace(/\.com$/, ".app");
  return new URL(`https://mcp__demo.${projectHostnameBase}/`);
}

function hasSeededProjectHost(projectMcpUrlOverride: URL | null) {
  return projectMcpUrlOverride !== null;
}

const baseUrl = requireBaseUrl();
const projectMcpUrlOverride = readProjectMcpUrlOverride();

// This smoke test intentionally avoids authenticated application procedures.
// Preview CI has no stable seeded Clerk user/project, so it proves the deployed
// edge contract that must work before browser-led auth tests can run.
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

const projectMcpUrl = projectMcpUrlFor(baseUrl, projectMcpUrlOverride);

if (!hasSeededProjectHost(projectMcpUrlOverride)) {
  await expectStatus({
    url: projectMcpUrl,
    status: 404,
  });
  console.log(`OS2 preview smoke passed for ${baseUrl.toString()}`);
  process.exit(0);
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
