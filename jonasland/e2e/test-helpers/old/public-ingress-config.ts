import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

const DEFAULT_INGRESS_PROXY_BASE_URL = "https://ingress.iterate.com";
const DEFAULT_INGRESS_PROXY_DOMAIN = "ingress.iterate.com";

export type IngressProxyConfig = {
  ingressProxyApiKey: string;
  ingressProxyBaseUrl: string;
  ingressProxyDomain: string;
};

export function sanitizeIngressSlug(input: string): string {
  return input
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 32);
}

export function resolveIngressProxyConfig(overrideApiKey?: string): IngressProxyConfig {
  const ingressProxyApiKey = overrideApiKey?.trim() || process.env.INGRESS_PROXY_API_TOKEN?.trim();
  ("");
  if (!ingressProxyApiKey) {
    throw new Error("Missing ingress proxy API key (set INGRESS_PROXY_API_TOKEN)");
  }

  const ingressProxyBaseUrl = (
    process.env.JONASLAND_E2E_INGRESS_PROXY_BASE_URL ??
    process.env.INGRESS_PROXY_BASE_URL ??
    DEFAULT_INGRESS_PROXY_BASE_URL
  )
    .trim()
    .replace(/\/+$/, "");
  const ingressProxyDomain = (
    process.env.JONASLAND_E2E_INGRESS_PROXY_DOMAIN ??
    process.env.INGRESS_PROXY_DOMAIN ??
    DEFAULT_INGRESS_PROXY_DOMAIN
  ).trim();

  return {
    ingressProxyApiKey,
    ingressProxyBaseUrl,
    ingressProxyDomain,
  };
}

export async function allocateLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate loopback port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

export function buildIngressPublicBaseUrl(params: {
  testSlug: string;
  ingressProxyDomain: string;
}): string {
  const slug = sanitizeIngressSlug(params.testSlug);
  const nonce = randomUUID().slice(0, 6);
  return `https://${slug}-${nonce}.${params.ingressProxyDomain}`;
}
