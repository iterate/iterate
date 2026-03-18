import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { registryContract } from "@iterate-com/registry-contract";

export type RegistryClient = ContractRouterClient<typeof registryContract>;

function toBasePath(url?: string): string {
  if (!url) return "";

  if (/^https?:\/\//.test(url)) {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/(?:orpc|api)\/?$/, "")}`;
  }

  return url.replace(/\/(?:orpc|api)\/?$/, "");
}

function joinPath(basePath: string, suffix: string) {
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  return `${base}${suffix}`;
}

export function createRegistryClient(params?: {
  url?: string;
  fetch?: typeof fetch;
}): RegistryClient {
  const basePath = toBasePath(params?.url);
  const link = new OpenAPILink(registryContract, {
    url: joinPath(basePath, "/api"),
    ...(params?.fetch ? { fetch: params.fetch } : {}),
  });
  return createORPCClient(link);
}
