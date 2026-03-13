const DEFAULT_TARGET_PORT = 3000;

const _buildProjectPortUrl = (params: {
  readonly projectBaseUrl: string;
  readonly port: number;
  readonly path?: string;
}): string => {
  const url = new URL(params.projectBaseUrl);
  if (params.port !== DEFAULT_TARGET_PORT) {
    url.hostname = `${String(params.port)}__${url.hostname}`;
  }
  if (params.path !== undefined) {
    url.pathname = params.path.startsWith("/") ? params.path : `/${params.path}`;
  }
  return url.toString();
};

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
  readonly preferSameOrigin?: boolean;
}): string => {
  const candidate = params.env.ITERATE_PROJECT_BASE_URL?.trim();

  if (params.preferSameOrigin && candidate) {
    const parsed = new URL(candidate);
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  }

  if (candidate) {
    const parsed = new URL(candidate);

    if (parsed.port !== "") {
      parsed.hostname = parsed.hostname.replace(/^[0-9]+__/, "");
      parsed.port = String(params.manifest.port);
      parsed.pathname = "/";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }

    parsed.hostname = parsed.hostname.replace(/^[a-z0-9_-]+__/, "");
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";

    if (params.manifest.port === DEFAULT_TARGET_PORT) {
      return parsed.toString();
    }

    const baseUrl = parsed.toString();
    const url = new URL(baseUrl);
    url.hostname = `${params.manifest.slug}__${url.hostname}`;
    return url.toString();
  }

  return `http://127.0.0.1:${params.manifest.port}/`;
};

export const resolveServiceOrpcUrl = (params: {
  readonly env: ServiceClientEnv;
  readonly manifest: ServiceManifestLike;
  readonly preferSameOrigin?: boolean;
}): string => new URL("/orpc", resolveServiceBaseUrl(params)).toString();

export const resolveServiceOrpcWebSocketUrl = (params: {
  readonly env: ServiceClientEnv;
  readonly manifest: ServiceManifestLike;
  readonly preferSameOrigin?: boolean;
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
  readonly preferSameOrigin?: boolean;
}): string => new URL("/openapi.json", resolveServiceBaseUrl(params)).toString();

export const resolveServiceOpenApiBaseUrl = (params: {
  readonly env: ServiceClientEnv;
  readonly manifest: ServiceManifestLike;
  readonly preferSameOrigin?: boolean;
}): string => new URL("/api", resolveServiceBaseUrl(params)).toString();
