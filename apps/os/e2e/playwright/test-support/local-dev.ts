import { fileURLToPath } from "node:url";
import { readLocalDevServerInfo } from "@iterate-com/shared/alchemy/local-dev-server";

export const OS_APP_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));

export async function waitForLocalOsBaseUrl(input: { timeoutMs?: number } = {}) {
  const deadline = Date.now() + (input.timeoutMs || 60_000);
  let lastError = "local OS dev server has not written .alchemy/dev-server.json yet";

  while (Date.now() < deadline) {
    const baseUrl =
      process.env.OS_PLAYWRIGHT_BASE_URL ||
      readLocalDevServerInfo(OS_APP_ROOT, { requireLive: true })?.baseUrl.replace(/\/+$/, "");
    if (baseUrl) {
      assertLoopbackBaseUrl(baseUrl);
      const health = await probeHealth(baseUrl);
      if (health.ok) return baseUrl;
      lastError = health.error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`Timed out waiting for local OS dev server: ${lastError}`);
}

async function probeHealth(baseUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = new URL("/api/health", baseUrl);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (response.ok) return { ok: true };
    return { ok: false, error: `GET ${url.toString()} returned ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function assertLoopbackBaseUrl(baseUrl: string) {
  const { hostname } = new URL(baseUrl);
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  ) {
    return;
  }
  throw new Error(
    `OS Playwright e2e is localhost-only; refusing to run against non-loopback base URL ${baseUrl}`,
  );
}
