export interface CfProxyWorkerRoute {
  route: string;
  target: string;
  headers: Record<string, string>;
  metadata: Record<string, unknown>;
  status: "active" | "expired" | "disabled";
  ttlSeconds: number | null;
  expiresAt: string | null;
  expiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CfProxyWorkerClient {
  listRoutes(): Promise<CfProxyWorkerRoute[]>;
  setRoute(input: {
    route: string;
    target: string;
    headers?: Record<string, string>;
    metadata?: Record<string, unknown>;
    ttlSeconds?: number | null;
  }): Promise<CfProxyWorkerRoute>;
  deleteRoute(input: { route: string }): Promise<{ deleted: boolean }>;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("cf-proxy-worker base URL is required");
  return trimmed;
}

async function requestOrpc<T>(params: {
  baseUrl: string;
  token: string;
  procedure: string;
  input?: unknown;
}): Promise<T> {
  const response = await fetch(`${params.baseUrl}/api/orpc/${params.procedure}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ json: params.input ?? {} }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `cf-proxy-worker ${params.procedure} failed (${response.status}): ${body || response.statusText}`,
    );
  }

  const payload = (await response.json()) as { json: T };
  return payload.json;
}

export function createCfProxyWorkerClient(params: {
  baseUrl: string;
  token: string;
}): CfProxyWorkerClient {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const token = params.token.trim();
  if (!token) {
    throw new Error("cf-proxy-worker token is required");
  }

  return {
    listRoutes: async () =>
      await requestOrpc<CfProxyWorkerRoute[]>({
        baseUrl,
        token,
        procedure: "listRoutes",
      }),
    setRoute: async (input) =>
      await requestOrpc<CfProxyWorkerRoute>({
        baseUrl,
        token,
        procedure: "setRoute",
        input,
      }),
    deleteRoute: async (input) =>
      await requestOrpc<{ deleted: boolean }>({
        baseUrl,
        token,
        procedure: "deleteRoute",
        input,
      }),
  };
}
