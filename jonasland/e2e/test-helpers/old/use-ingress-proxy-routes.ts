export interface IngressProxyPatternInput {
  pattern: string;
  target: string;
  headers?: Record<string, string>;
}

export interface IngressProxyRouteInput {
  metadata?: Record<string, unknown>;
  patterns: IngressProxyPatternInput[];
}

export interface UseIngressProxyRoutesOptions {
  ingressProxyApiKey: string;
  routes: IngressProxyRouteInput[];
  ingressProxyBaseUrl?: string;
}

export interface IngressProxyRouteRecord {
  routeId: string;
  metadata: Record<string, unknown>;
  patterns: Array<{
    patternId: number;
    pattern: string;
    target: string;
    headers: Record<string, string>;
    createdAt: string;
    updatedAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface IngressProxyRoutesHandle extends AsyncDisposable {
  readonly createdRoutes: ReadonlyArray<IngressProxyRouteRecord>;
  readonly routeIds: ReadonlyArray<string>;
  deleteAll(): Promise<void>;
}

const DEFAULT_INGRESS_PROXY_BASE_URL = "https://ingress.iterate.com";

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

async function callIngressProxyProcedure<TResponse>(params: {
  baseUrl: string;
  apiKey: string;
  name: string;
  input: unknown;
}): Promise<TResponse> {
  const response = await fetch(`${params.baseUrl}/api/orpc/${params.name}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ json: params.input }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    json?: TResponse;
    error?: unknown;
  };

  if (!response.ok) {
    throw new Error(
      `ingress proxy ${params.name} failed (${response.status}): ${JSON.stringify(payload.json ?? payload.error ?? payload)}`,
    );
  }
  if (payload.json === undefined) {
    throw new Error(`ingress proxy ${params.name} returned no json payload`);
  }

  return payload.json;
}

async function createIngressRoute(params: {
  baseUrl: string;
  apiKey: string;
  route: IngressProxyRouteInput;
}): Promise<IngressProxyRouteRecord> {
  return await callIngressProxyProcedure<IngressProxyRouteRecord>({
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    name: "createRoute",
    input: {
      metadata: params.route.metadata ?? {},
      patterns: params.route.patterns,
    },
  });
}

async function deleteIngressRoute(params: {
  baseUrl: string;
  apiKey: string;
  routeId: string;
}): Promise<void> {
  await callIngressProxyProcedure<{ deleted: boolean }>({
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    name: "deleteRoute",
    input: {
      routeId: params.routeId,
    },
  });
}

export async function useIngressProxyRoutes(
  options: UseIngressProxyRoutesOptions,
): Promise<IngressProxyRoutesHandle> {
  const baseUrl = normalizeBaseUrl(options.ingressProxyBaseUrl ?? DEFAULT_INGRESS_PROXY_BASE_URL);
  const apiKey = options.ingressProxyApiKey.trim();
  if (!apiKey) {
    throw new Error("ingressProxyApiKey is required");
  }
  if (options.routes.length === 0) {
    throw new Error("routes must contain at least one route");
  }

  const createdRoutes: IngressProxyRouteRecord[] = [];
  let deleted = false;

  const deleteAll = async (): Promise<void> => {
    if (deleted) return;
    deleted = true;

    const failures: string[] = [];
    for (const route of [...createdRoutes].reverse()) {
      await deleteIngressRoute({
        baseUrl,
        apiKey,
        routeId: route.routeId,
      }).catch((error) => {
        failures.push(
          `failed deleting route ${route.routeId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }

    if (failures.length > 0) {
      throw new Error(failures.join("\n"));
    }
  };

  try {
    for (const route of options.routes) {
      createdRoutes.push(
        await createIngressRoute({
          baseUrl,
          apiKey,
          route,
        }),
      );
    }
  } catch (error) {
    await deleteAll().catch(() => {});
    throw error;
  }

  return {
    createdRoutes,
    routeIds: createdRoutes.map((route) => route.routeId),
    deleteAll,
    async [Symbol.asyncDispose]() {
      await deleteAll();
    },
  };
}
