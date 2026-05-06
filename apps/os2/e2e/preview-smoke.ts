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

type Project = {
  id: string;
  slug: string;
};

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

async function fetchProjectBySlug(input: { adminApiSecret: string; baseUrl: URL; slug: string }) {
  const response = await fetch(new URL(`/api/projects/by-slug/${input.slug}`, input.baseUrl), {
    headers: {
      authorization: `Bearer ${input.adminApiSecret}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to find MCP smoke project ${input.slug}: ${response.status} ${await response.text()}`,
    );
  }

  return (await response.json()) as Project;
}

async function seedProject(input: { adminApiSecret: string; baseUrl: URL }) {
  const slug = "preview-mcp-smoke";
  const response = await fetch(new URL("/api/projects", input.baseUrl), {
    body: JSON.stringify({
      metadata: {
        seededAt: new Date().toISOString(),
        seededBy: "os2-preview-mcp-smoke",
      },
      slug,
    }),
    headers: {
      authorization: `Bearer ${input.adminApiSecret}`,
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (response.status === 409) {
    return await fetchProjectBySlug({ ...input, slug });
  }

  if (!response.ok) {
    throw new Error(
      `Failed to create MCP smoke project at ${input.baseUrl}: ${response.status} ${await response.text()}`,
    );
  }

  return (await response.json()) as Project;
}

function projectMcpUrlFor(input: { baseUrl: URL; project: Project }) {
  const previewMatch = /^os2\.iterate-preview-(\d+)\.com$/.exec(input.baseUrl.hostname);
  if (previewMatch) {
    return new URL(`https://mcp__${input.project.slug}.iterate-preview-${previewMatch[1]}.app/`);
  }

  if (input.baseUrl.hostname === "os2.iterate.com") {
    return new URL(`https://mcp__${input.project.slug}.iterate.app/`);
  }

  throw new Error(
    `Cannot derive project MCP URL for ${input.project.slug} from OS2 base ${input.baseUrl}. Set OS2_PROJECT_MCP_URL explicitly.`,
  );
}

async function seedProjectMcpUrl(input: { adminApiSecret: string; baseUrl: URL }) {
  // The preview smoke deliberately uses the normal `projects.create` and
  // `projects.findBySlug` procedures. `activeOrganizationMiddleware` maps the
  // admin bearer token to a tiny synthetic organization, keeping this path close
  // to the UI while still making preview checks repeatable without Clerk.
  const project = await seedProject(input);
  return projectMcpUrlFor({ baseUrl: input.baseUrl, project });
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
