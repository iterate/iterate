import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { useCloudflareTunnel } from "./test-helpers/old/use-cloudflare-tunnel.ts";
import { useIngressProxyRoutes } from "./test-helpers/old/use-ingress-proxy-routes.ts";

const DEFAULT_INGRESS_PROXY_BASE_URL = "https://ingress.iterate.com";
const DEFAULT_INGRESS_PROXY_DOMAIN = "ingress.iterate.com";

function firstNonEmpty(values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (trimmed) return trimmed;
  }
  return "";
}

async function readBodySnippet(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const normalized = text.trim().replace(/\s+/g, " ");
    return normalized.slice(0, 200);
  } catch {
    return "";
  }
}

function gitOutput(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function resolveDockerHostSync() {
  const repoRoot = gitOutput(["rev-parse", "--show-toplevel"]);
  const gitDir = gitOutput(["rev-parse", "--path-format=absolute", "--git-dir"]);
  const commonDir = gitOutput(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return {
    repoRoot,
    gitDir,
    commonDir,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function retry<T>(params: {
  timeoutMs: number;
  intervalMs: number;
  label: string;
  run: () => Promise<T>;
  onRetry?: (details: { attempt: number; elapsedMs: number; error: unknown }) => void;
}): Promise<T> {
  const deadline = Date.now() + params.timeoutMs;
  const startedAt = Date.now();
  let attempt = 0;
  let lastError: unknown = new Error(`${params.label} failed before first attempt`);
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      return await params.run();
    } catch (error) {
      lastError = error;
      params.onRetry?.({
        attempt,
        elapsedMs: Date.now() - startedAt,
        error,
      });
      await sleep(params.intervalMs);
    }
  }
  throw new Error(
    `[playground] self-check failed: ${params.label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function runSelfChecks(params: {
  deployment: DockerDeployment;
  slug: string;
  ingressProxyDomain: string;
  tunnelUrl: string;
}): Promise<void> {
  const eventsHost = `events__${params.slug}.${params.ingressProxyDomain}`;
  const eventsOrigin = `https://${eventsHost}`;
  const ingressListStreamsUrl = `${eventsOrigin}/orpc/listStreams`;
  const ingressHealthUrl = `${eventsOrigin}/api/service/health`;
  const tunnelListStreamsUrl = `${params.tunnelUrl}/orpc/listStreams`;
  const tunnelHealthUrl = `${params.tunnelUrl}/api/service/health`;
  const forwardedHostHeaders = { "x-forwarded-host": eventsHost };
  const expectedPublicBaseUrl = `https://${params.slug}.${params.ingressProxyDomain}`;

  console.log("[playground] self-check 0/3 waiting for registry public URL config");
  await retry({
    timeoutMs: 60_000,
    intervalMs: 1_000,
    label: "registry.getPublicURL reflects ingress base URL",
    run: async () => {
      const result = await params.deployment.registry.getPublicURL({
        internalURL: "http://events.iterate.localhost/api/service/health",
      });
      if (!result.publicURL.includes(`events__${params.slug}.${params.ingressProxyDomain}`)) {
        throw new Error(
          `unexpected publicURL=${result.publicURL} expected host suffix events__${params.slug}.${params.ingressProxyDomain}`,
        );
      }
      return result;
    },
  });
  console.log(
    `[playground] self-check PASS: registry uses ITERATE_PUBLIC_BASE_URL=${expectedPublicBaseUrl}`,
  );

  console.log("[playground] self-check 1/4 waiting for events ingress health (required)");
  const ingressHealthResponse = await retry({
    timeoutMs: 60_000,
    intervalMs: 1_000,
    label: "events ingress health",
    onRetry: ({ attempt, elapsedMs, error }) => {
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        `[playground] self-check 1/4 retry #${String(attempt)} elapsed=${String(elapsedMs)}ms ${message}`,
      );
    },
    run: async () => {
      const response = await fetch(ingressHealthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        const bodySnippet = await readBodySnippet(response);
        const cfRay = response.headers.get("cf-ray");
        throw new Error(
          `status=${String(response.status)} cf-ray=${String(cfRay)} body=${bodySnippet || "<empty>"}`,
        );
      }
      return response;
    },
  });
  console.log(
    `[playground] self-check PASS: ingress health ${String(ingressHealthResponse.status)} ${ingressHealthUrl}`,
  );

  console.log(
    "[playground] self-check 2/4 waiting for events health via tunnel + X-Forwarded-Host",
  );
  const tunnelHealthResponse = await retry({
    timeoutMs: 60_000,
    intervalMs: 1_000,
    label: "events tunnel forwarded-host health",
    run: async () => {
      const response = await fetch(tunnelHealthUrl, {
        method: "GET",
        headers: forwardedHostHeaders,
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        throw new Error(`status=${String(response.status)}`);
      }
      return response;
    },
  });
  console.log(
    `[playground] self-check PASS: tunnel health ${String(tunnelHealthResponse.status)} ${tunnelHealthUrl}`,
  );

  console.log("[playground] self-check 3/4 CORS preflight for /orpc/listStreams (tunnel+xfh)");
  const preflightResponse = await retry({
    timeoutMs: 30_000,
    intervalMs: 1_000,
    label: "CORS preflight /orpc/listStreams",
    run: async () => {
      const response = await fetch(tunnelListStreamsUrl, {
        method: "OPTIONS",
        signal: AbortSignal.timeout(8_000),
        headers: {
          ...forwardedHostHeaders,
          Origin: eventsOrigin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      const allowOrigin = response.headers.get("access-control-allow-origin");
      if (response.status !== 204) {
        throw new Error(`expected 204, got ${String(response.status)}`);
      }
      if (allowOrigin !== eventsOrigin) {
        throw new Error(`expected ACAO=${eventsOrigin}, got ${String(allowOrigin)}`);
      }
      return response;
    },
  });
  console.log(
    `[playground] self-check PASS: preflight ${String(preflightResponse.status)} ACAO=${preflightResponse.headers.get("access-control-allow-origin")}`,
  );

  console.log("[playground] self-check 4/4 CORS POST /orpc/listStreams (tunnel+xfh)");
  const postResponse = await retry({
    timeoutMs: 30_000,
    intervalMs: 1_000,
    label: "CORS POST /orpc/listStreams",
    run: async () => {
      const response = await fetch(tunnelListStreamsUrl, {
        method: "POST",
        signal: AbortSignal.timeout(8_000),
        headers: {
          ...forwardedHostHeaders,
          Origin: eventsOrigin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ json: {} }),
      });
      const allowOrigin = response.headers.get("access-control-allow-origin");
      if (!response.ok) {
        throw new Error(`status=${String(response.status)}`);
      }
      if (allowOrigin !== eventsOrigin) {
        throw new Error(`expected ACAO=${eventsOrigin}, got ${String(allowOrigin)}`);
      }
      return response;
    },
  });
  console.log(
    `[playground] self-check PASS: POST ${String(postResponse.status)} ACAO=${postResponse.headers.get("access-control-allow-origin")}`,
  );
}

async function main(): Promise<void> {
  const dockerImage = firstNonEmpty([
    process.env.E2E_DOCKER_IMAGE_REF,
    process.env.JONASLAND_SANDBOX_IMAGE,
  ]);
  if (!dockerImage) {
    throw new Error("set E2E_DOCKER_IMAGE_REF or JONASLAND_SANDBOX_IMAGE");
  }

  const ingressProxyApiKey = firstNonEmpty([
    process.env.INGRESS_PROXY_API_TOKEN,
    process.env.INGRESS_PROXY_E2E_API_TOKEN,
  ]);
  if (!ingressProxyApiKey) {
    throw new Error("set INGRESS_PROXY_API_TOKEN or INGRESS_PROXY_E2E_API_TOKEN");
  }

  const ingressProxyBaseUrl =
    firstNonEmpty([
      process.env.JONASLAND_E2E_INGRESS_PROXY_BASE_URL,
      process.env.INGRESS_PROXY_BASE_URL,
    ]) || DEFAULT_INGRESS_PROXY_BASE_URL;
  const ingressProxyDomain =
    firstNonEmpty([
      process.env.JONASLAND_E2E_INGRESS_PROXY_DOMAIN,
      process.env.INGRESS_PROXY_DOMAIN,
    ]) || DEFAULT_INGRESS_PROXY_DOMAIN;

  const cloudflaredBin = firstNonEmpty([
    process.env.JONASLAND_E2E_CLOUDFLARED_BIN,
    process.env.CLOUDFLARED_BIN,
  ]);
  const dockerHostSync = resolveDockerHostSync();

  console.log("[playground] 1/4 creating docker deployment");
  console.log(
    `[playground] docker host sync enabled repoRoot=${dockerHostSync.repoRoot} gitDir=${dockerHostSync.gitDir} commonDir=${dockerHostSync.commonDir}`,
  );
  await using deployment = await DockerDeployment.create({
    dockerImage,
    name: `playground-${randomUUID().slice(0, 8)}`,
    dockerHostSync,
  });

  console.log(`[playground] deployment base URL: ${deployment.baseUrl}`);
  console.log("[playground] waiting for deployment health");
  await deployment.waitUntilAlive({ signal: AbortSignal.timeout(120_000) });

  const deploymentPort = Number(new URL(deployment.baseUrl).port);
  if (!Number.isFinite(deploymentPort) || deploymentPort <= 0) {
    throw new Error(`invalid deployment port from base URL: ${deployment.baseUrl}`);
  }

  console.log("[playground] 2/4 creating cloudflare tunnel");
  await using tunnel = await useCloudflareTunnel({
    localPort: deploymentPort,
    timeoutMs: 120_000,
    onDebug: (message) => console.log(message),
    waitForReady: false,
    ...(cloudflaredBin ? { cloudflaredBin } : {}),
  });

  console.log(`[playground] tunnel URL: ${tunnel.tunnelUrl}`);

  const slug = `playground-${randomUUID().slice(0, 8)}`;
  const wildcardHost = `*__${slug}.${ingressProxyDomain}`;
  const rootHost = `${slug}.${ingressProxyDomain}`;
  const publicBaseUrl = `https://${slug}.${ingressProxyDomain}`;
  const publicBaseUrlType =
    firstNonEmpty([
      process.env.JONASLAND_E2E_PUBLIC_BASE_URL_TYPE,
      process.env.ITERATE_PUBLIC_BASE_URL_TYPE,
    ]) || "prefix";

  console.log("[playground] 3/4 creating ingress routes");
  await using routes = await useIngressProxyRoutes({
    ingressProxyApiKey,
    ingressProxyBaseUrl,
    routes: [
      {
        metadata: { source: "playground-script", slug },
        patterns: [
          { pattern: wildcardHost, target: tunnel.tunnelUrl },
          { pattern: rootHost, target: tunnel.tunnelUrl },
        ],
      },
    ],
  });

  console.log(`[playground] route IDs: ${routes.routeIds.join(", ")}`);
  console.log(
    `[playground] setting deployment env vars: ITERATE_PUBLIC_BASE_URL=${publicBaseUrl} ITERATE_PUBLIC_BASE_URL_TYPE=${publicBaseUrlType}`,
  );
  await deployment.setEnvVars({
    ITERATE_PUBLIC_BASE_URL: publicBaseUrl,
    ITERATE_PUBLIC_BASE_URL_TYPE: publicBaseUrlType,
  });
  console.log("[playground] waiting for registry to pick up ~/.iterate/.env changes");
  await runSelfChecks({
    deployment,
    slug,
    ingressProxyDomain,
    tunnelUrl: tunnel.tunnelUrl,
  });
  console.log("");
  console.log("[playground] ready for manual testing");
  console.log("[playground] default ingress service: home");
  console.log(`[playground] local deployment: ${deployment.baseUrl}`);
  console.log(`[playground] cloudflare tunnel: ${tunnel.tunnelUrl}`);
  console.log(`[playground] ingress wildcard pattern: https://${wildcardHost}/`);
  console.log(`[playground] ingress root: https://${rootHost}/`);
  console.log("[playground] likely-working service URLs:");
  console.log(`[playground] - https://events__${slug}.${ingressProxyDomain}/api/service/health`);
  console.log(`[playground] - https://registry__${slug}.${ingressProxyDomain}/api/routes`);
  console.log(`[playground] - https://home__${slug}.${ingressProxyDomain}/`);
  console.log(
    `[playground] tunnel direct with x-forwarded-host: ${tunnel.tunnelUrl}/api/service/health`,
  );
  console.log("[playground] 4/4 press Enter to teardown");
  console.log("");

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    await rl.question("");
  } finally {
    rl.close();
  }

  console.log("[playground] tearing down (routes -> tunnel -> deployment)");
}

main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[playground] fatal: ${message}`);
  process.exitCode = 1;
});
