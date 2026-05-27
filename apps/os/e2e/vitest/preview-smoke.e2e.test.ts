import { test } from "vitest";

function requireBaseUrl() {
  const baseUrl = process.env.APP_CONFIG_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Error("APP_CONFIG_BASE_URL is required for the OS preview smoke test.");
  }
  return new URL(baseUrl);
}

function readProjectMcpUrlOverride() {
  const url = process.env.OS_PROJECT_MCP_URL?.trim();
  return url ? new URL(url) : null;
}

function readAdminApiSecret() {
  return (
    process.env.OS_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
    null
  );
}

function previewSmokeProjectSlug() {
  const explicitSlug = process.env.OS_PREVIEW_SMOKE_PROJECT_SLUG?.trim();
  if (explicitSlug) return explicitSlug;

  const commit = process.env.GITHUB_SHA?.trim().slice(0, 8) || "manual";
  return `preview-mcp-smoke-${commit}`;
}

type Project = {
  id: string;
  slug: string;
};

async function expectStatus(input: { method?: string; status: number; url: URL }) {
  const response = await fetchWithTransientRetry({
    init: {
      method: input.method ?? "GET",
      redirect: "manual",
    },
    url: input.url,
  });
  if (response.status !== input.status) {
    throw new Error(`Expected ${input.status} from ${input.url}; received ${response.status}.`);
  }
  return response;
}

async function fetchWithTransientRetry(input: {
  attempts?: number;
  init?: RequestInit;
  retryDelayMs?: number;
  url: URL;
}) {
  const attempts = input.attempts ?? 6;
  const retryDelayMs = input.retryDelayMs ?? 5_000;
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(input.url, {
      ...input.init,
      redirect: input.init?.redirect ?? "manual",
    });
    lastResponse = response;
    if (![502, 503, 504].includes(response.status) || attempt === attempts) {
      return response;
    }

    response.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  if (lastResponse) return lastResponse;
  throw new Error(`No response received from ${input.url}`);
}

async function expectOkText(input: { headers?: HeadersInit; url: URL }) {
  const response = await fetchWithTransientRetry({
    init: {
      headers: input.headers,
      redirect: "manual",
    },
    url: input.url,
  });
  if (!response.ok) {
    throw new Error(`Expected ok response from ${input.url}; received ${response.status}.`);
  }
  return await response.text();
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
  const slug = previewSmokeProjectSlug();
  const response = await fetch(new URL("/api/projects", input.baseUrl), {
    body: JSON.stringify({
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
  const previewMatch = /^os\.iterate-preview-(\d+)\.com$/.exec(input.baseUrl.hostname);
  if (previewMatch) {
    return new URL(`https://mcp__${input.project.slug}.iterate-preview-${previewMatch[1]}.app/`);
  }

  if (input.baseUrl.hostname === "os.iterate.com") {
    return new URL(`https://mcp__${input.project.slug}.iterate.app/`);
  }

  throw new Error(
    `Cannot derive project MCP URL for ${input.project.slug} from OS base ${input.baseUrl}. Set OS_PROJECT_MCP_URL explicitly.`,
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

// TODO: Re-enable once preview smoke follows the canonical /mcp route instead of
// the retired project MCP hostname flow.
test.skip("OS preview smoke", async () => {
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
    console.log(`OS preview smoke passed for ${baseUrl.toString()} (MCP project seed skipped)`);
    return;
  }

  const instructionsHtml = await expectOkText({
    headers: { accept: "text/html" },
    url: projectMcpUrl,
  });
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

  console.log(`OS preview smoke passed for ${baseUrl.toString()}`);
});
