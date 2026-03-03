import { randomUUID } from "node:crypto";
import type { DockerDeployment } from "@iterate-com/shared/jonasland/deployment";
import { useCloudflareTunnel } from "./use-cloudflare-tunnel.ts";
import { useIngressProxyRoutes } from "./use-ingress-proxy-routes.ts";

const DEFAULT_INGRESS_PROXY_BASE_URL = "https://ingress.iterate.com";
const DEFAULT_INGRESS_PROXY_DOMAIN = "ingress.iterate.com";
const EXTERNAL_SERVICE_NAMES = ["events", "registry", "pidnap", "frp", "caddy-admin"] as const;

type PatchableDockerDeployment = {
  getDeploymentLocator(): { name?: string };
  ports: { ingress: number };
  ingressUrl: () => Promise<string>;
  ingressConfig?: {
    publicBaseUrl: string;
    publicBaseUrlType: "prefix" | "subdomain";
    createIngressProxyRoutes: boolean;
    ingressProxyTargetUrl: string;
  } | null;
};

export interface UseDockerPublicIngressOptions {
  deployment: DockerDeployment;
  testSlug?: string;
  ingressProxyApiKey?: string;
  ingressProxyBaseUrl?: string;
  ingressProxyDomain?: string;
  cloudflaredBin?: string;
}

export interface DockerPublicIngressHandle extends AsyncDisposable {
  ingressBaseUrl: string;
  ingressHost: string;
  tunnelUrl: string;
  teardown(): Promise<void>;
}

function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 32);
}

function resolveIngressProxyApiKey(override?: string): string {
  const apiKey =
    override?.trim() ||
    process.env.INGRESS_PROXY_API_TOKEN?.trim() ||
    process.env.INGRESS_PROXY_E2E_API_TOKEN?.trim() ||
    "";
  if (!apiKey) {
    throw new Error(
      "Missing ingress proxy API key (set INGRESS_PROXY_API_TOKEN or INGRESS_PROXY_E2E_API_TOKEN)",
    );
  }
  return apiKey;
}

async function waitForIngressReady(params: {
  ingressBaseUrl: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 90_000;
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | undefined;
  let lastBody = "";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/healthz", params.ingressBaseUrl), {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      lastStatus = response.status;
      const body = await response.text();
      lastBody = body;
      if (response.ok && /ok|caddy/i.test(body)) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `timed out waiting for docker public ingress readiness at ${params.ingressBaseUrl}/healthz (status=${String(lastStatus)} body=${JSON.stringify(lastBody.slice(0, 200))})`,
  );
}

export async function useDockerPublicIngress(
  options: UseDockerPublicIngressOptions,
): Promise<DockerPublicIngressHandle> {
  const deployment = options.deployment as unknown as PatchableDockerDeployment;

  const ingressProxyApiKey = resolveIngressProxyApiKey(options.ingressProxyApiKey);
  const ingressProxyBaseUrl = (
    options.ingressProxyBaseUrl ??
    process.env.JONASLAND_E2E_INGRESS_PROXY_BASE_URL ??
    process.env.INGRESS_PROXY_BASE_URL ??
    DEFAULT_INGRESS_PROXY_BASE_URL
  )
    .trim()
    .replace(/\/+$/, "");
  const ingressProxyDomain = (
    options.ingressProxyDomain ??
    process.env.JONASLAND_E2E_INGRESS_PROXY_DOMAIN ??
    process.env.INGRESS_PROXY_DOMAIN ??
    DEFAULT_INGRESS_PROXY_DOMAIN
  ).trim();

  const slugBase = sanitizeSlug(
    options.testSlug ??
      deployment.getDeploymentLocator().name ??
      `docker-public-${randomUUID().slice(0, 8)}`,
  );
  const ingressHost = `${slugBase}-${randomUUID().slice(0, 6)}.${ingressProxyDomain}`;
  const ingressBaseUrl = `https://${ingressHost}`;

  const tunnel = await useCloudflareTunnel({
    localPort: deployment.ports.ingress,
    cloudflaredBin: options.cloudflaredBin ?? process.env.JONASLAND_E2E_CLOUDFLARED_BIN,
  });

  const routes = await useIngressProxyRoutes({
    ingressProxyApiKey,
    ingressProxyBaseUrl,
    routes: [
      {
        metadata: {
          source: "jonasland-docker-public-ingress-fixture",
          ingressHost,
          tunnelUrl: tunnel.tunnelUrl,
        },
        patterns: [
          {
            pattern: ingressHost,
            target: tunnel.tunnelUrl,
          },
          ...EXTERNAL_SERVICE_NAMES.map((service) => ({
            pattern: `${service}__${ingressHost}`,
            target: tunnel.tunnelUrl,
            headers: {
              Host: `${service}__${ingressHost}`,
            },
          })),
        ],
      },
    ],
  });

  await waitForIngressReady({ ingressBaseUrl });

  const originalIngressUrl = deployment.ingressUrl.bind(deployment);
  const originalIngressConfig = deployment.ingressConfig ?? null;
  deployment.ingressUrl = async () => ingressBaseUrl;
  deployment.ingressConfig = {
    publicBaseUrl: ingressBaseUrl,
    publicBaseUrlType: "prefix",
    createIngressProxyRoutes: false,
    ingressProxyTargetUrl: tunnel.tunnelUrl,
  };

  let tornDown = false;
  const teardown = async (): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    deployment.ingressUrl = originalIngressUrl;
    deployment.ingressConfig = originalIngressConfig;
    await routes[Symbol.asyncDispose]();
    await tunnel[Symbol.asyncDispose]();
  };

  return {
    ingressBaseUrl,
    ingressHost,
    tunnelUrl: tunnel.tunnelUrl,
    teardown,
    async [Symbol.asyncDispose]() {
      await teardown();
    },
  };
}
