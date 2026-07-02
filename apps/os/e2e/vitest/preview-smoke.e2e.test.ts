import { test } from "vitest";
import { createAdminOsItx, requireBaseUrl as requireOsBaseUrl } from "../test-support/os-client.ts";

function readProjectMcpUrlOverride() {
  const url = process.env.OS_PROJECT_MCP_URL?.trim();
  return url ? new URL(url) : null;
}

/**
 * Seeding goes through the admin itx handle, authenticated with
 * `APP_CONFIG_ADMIN_API_SECRET` (the Doppler-provided deployment secret).
 * Without it we skip the project seed and only check the public surface.
 */
function hasAdminApiSecret() {
  return Boolean(process.env.APP_CONFIG_ADMIN_API_SECRET?.trim());
}

function previewSmokeProjectSlug() {
  const explicitSlug = process.env.OS_PREVIEW_SMOKE_PROJECT_SLUG?.trim();
  if (explicitSlug) return explicitSlug;

  const commit = process.env.GITHUB_SHA?.trim().slice(0, 8) || "manual";
  return `preview-mcp-smoke-${commit}`;
}

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

/**
 * Ensure one deterministic project exists, via project-scoped itx — the same
 * surface the browser/CLI use now that the oRPC REST routes are gone. The smoke
 * only needs the project to EXIST (the MCP URL is derived from the deployment
 * host, not the project row), so a stable-slug CONFLICT from an earlier run is
 * success, not failure — no pagination or fetch-by-slug fallback required.
 */
async function seedProject(input: { baseUrl: URL }) {
  const slug = previewSmokeProjectSlug();
  using itx = createAdminOsItx({ baseUrl: input.baseUrl.toString() });
  try {
    await itx.projects.create({ slug });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (code !== "CONFLICT" && !/already exists/i.test(message)) {
      throw error;
    }
  }
}

function projectMcpUrlFor(input: { baseUrl: URL }) {
  const previewMatch = /^os\.iterate-preview-(\d+)\.com$/.exec(input.baseUrl.hostname);
  if (previewMatch) {
    return new URL(`https://mcp.iterate-preview-${previewMatch[1]}.com`);
  }

  if (input.baseUrl.hostname === "os.iterate.com") {
    return new URL("https://mcp.iterate.com");
  }

  throw new Error(
    `Cannot derive the MCP URL from OS base ${input.baseUrl}. Set OS_PROJECT_MCP_URL explicitly.`,
  );
}

function canDeriveProjectMcpUrl(input: { baseUrl: URL }) {
  return (
    /^os\.iterate-preview-(\d+)\.com$/.test(input.baseUrl.hostname) ||
    input.baseUrl.hostname === "os.iterate.com"
  );
}

async function seedProjectMcpUrl(input: { baseUrl: URL }) {
  // The preview smoke deliberately uses the normal `projects.create` itx
  // procedure (admin handle → synthetic operator org), keeping this path close
  // to the UI while still making preview checks repeatable without Clerk.
  await seedProject(input);
  return projectMcpUrlFor({ baseUrl: input.baseUrl });
}

test("OS preview smoke", async () => {
  const baseUrl = new URL(requireOsBaseUrl());
  const projectMcpUrlOverride = readProjectMcpUrlOverride();

  // Keep the dashboard checks unauthenticated, then use the admin preview hook to
  // seed one deterministic project before checking the canonical MCP endpoint.
  // That makes the preview proof
  // repeatable without relying on a human Clerk session.
  await expectStatus({
    url: new URL("/api/health", baseUrl),
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
    (hasAdminApiSecret() && canDeriveProjectMcpUrl({ baseUrl })
      ? await seedProjectMcpUrl({ baseUrl })
      : null);

  if (!projectMcpUrl) {
    console.log(`OS preview smoke passed for ${baseUrl.toString()} (MCP project seed skipped)`);
    return;
  }

  const projectMcpResponse = await expectStatus({
    url: projectMcpUrl,
    status: 401,
  });
  const wwwAuthenticate = projectMcpResponse.headers.get("www-authenticate") ?? "";
  const metadataUrl = new URL(
    ".well-known/oauth-protected-resource",
    `${projectMcpUrl.toString().replace(/\/+$/, "")}/`,
  );
  if (!wwwAuthenticate.includes(`resource_metadata="${metadataUrl.toString()}"`)) {
    throw new Error(`Unexpected MCP WWW-Authenticate header: ${wwwAuthenticate}`);
  }

  const metadataResponse = await expectStatus({
    url: metadataUrl,
    status: 200,
  });
  const metadata = (await metadataResponse.json()) as { resource?: string };
  const expectedResource = projectMcpUrl.toString().replace(/\/+$/, "");
  if (metadata.resource !== expectedResource) {
    throw new Error(
      `Expected MCP metadata resource ${expectedResource}; got ${metadata.resource}.`,
    );
  }

  console.log(`OS preview smoke passed for ${baseUrl.toString()}`);
});
