import { buildProjectPortUrl } from "@iterate-com/shared/project-ingress";

export interface ServiceClientEnv {
  readonly ITERATE_PROJECT_BASE_URL?: string;
}

export interface ServiceManifestLike<TContract = unknown> {
  readonly slug: string;
  readonly port: number;
  readonly orpcContract: TContract;
}

export const resolveServiceBaseUrl = (params: {
  readonly env: ServiceClientEnv;
  readonly manifest: ServiceManifestLike;
}): string => {
  const candidate = params.env.ITERATE_PROJECT_BASE_URL?.trim();

  if (candidate) {
    const parsed = new URL(candidate);

    // Explicit ports typically indicate direct local access (for example localhost:17301).
    // In that case we should preserve the origin exactly.
    if (parsed.port !== "") {
      parsed.pathname = "/";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }

    // If the hostname is already prefixed with "<port>__", normalize back to base
    // project hostname before applying the target port.
    parsed.hostname = parsed.hostname.replace(/^[0-9]+__/, "");
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";

    return buildProjectPortUrl({
      projectBaseUrl: parsed.toString(),
      port: params.manifest.port,
    });
  }

  return `http://127.0.0.1:${params.manifest.port}/`;
};

export const resolveServiceOrpcUrl = (params: {
  readonly env: ServiceClientEnv;
  readonly manifest: ServiceManifestLike;
}): string => new URL("/orpc", resolveServiceBaseUrl(params)).toString();

export const resolveServiceOrpcWebSocketUrl = (params: {
  readonly env: ServiceClientEnv;
  readonly manifest: ServiceManifestLike;
}): string => {
  const url = new URL(resolveServiceBaseUrl(params));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/orpc/ws/";
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const resolveServiceOpenApiUrl = (params: {
  readonly env: ServiceClientEnv;
  readonly manifest: ServiceManifestLike;
}): string => new URL("/openapi.json", resolveServiceBaseUrl(params)).toString();

export const resolveServiceOpenApiBaseUrl = (params: {
  readonly env: ServiceClientEnv;
  readonly manifest: ServiceManifestLike;
}): string => new URL("/api", resolveServiceBaseUrl(params)).toString();
