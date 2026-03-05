export interface RouteRecord {
  readonly host: string;
  readonly target: string;
  readonly metadata: Record<string, string>;
  readonly tags: string[];
  readonly updatedAt: string;
}

export interface ConfigEntry {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: string;
}

export interface RegistryClient {
  readonly getPublicURL: (input: { internalURL: string }) => Promise<{ publicURL: string }>;
  readonly service: {
    health: (_input: Record<string, never>) => Promise<{
      ok: true;
      service: string;
      version: string;
    }>;
    sql: (input: { statement: string }) => Promise<{
      rows: Array<Record<string, unknown>>;
      headers: Array<{
        name: string;
        displayName: string;
        originalType: string | null;
        type: 1 | 2 | 3 | 4;
      }>;
      stat: {
        rowsAffected: number;
        rowsRead: number | null;
        rowsWritten: number | null;
        queryDurationMs: number | null;
      };
      lastInsertRowid?: number;
    }>;
  };
  readonly routes: {
    list: (_input: Record<string, never>) => Promise<{ routes: RouteRecord[]; total: number }>;
    upsert: (input: {
      host: string;
      target: string;
      metadata?: Record<string, string>;
      tags?: string[];
    }) => Promise<{ route: RouteRecord; routeCount: number }>;
    remove: (input: { host: string }) => Promise<{ removed: boolean; routeCount: number }>;
    caddyLoadInvocation: (input: {
      listenAddress?: string;
      adminUrl?: string;
      apply?: boolean;
    }) => Promise<{
      invocation: {
        method: "POST";
        path: "/load";
        url: string;
        body: unknown;
      };
      routeCount: number;
      applied: boolean;
    }>;
  };
  readonly config: {
    get: (input: { key: string }) => Promise<{ found: boolean; entry?: ConfigEntry }>;
    list: (_input: Record<string, never>) => Promise<{ entries: ConfigEntry[]; total: number }>;
    set: (input: { key: string; value: unknown }) => Promise<{ entry: ConfigEntry }>;
  };
}

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
  fetch?: (request: Request) => Promise<Response>;
}): RegistryClient {
  const basePath = toBasePath(params?.url);
  const fetchImpl =
    params?.fetch ??
    (async (request: Request) => {
      return await fetch(request);
    });

  const requestJson = async <T>(
    path: string,
    init?: RequestInit,
    options?: { orpc?: boolean },
  ): Promise<T> => {
    const request = new Request(joinPath(basePath, path), init);
    const response = await fetchImpl(request);
    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }
    const payload = (await response.json()) as unknown;
    if (options?.orpc && payload && typeof payload === "object" && "json" in payload) {
      return (payload as { json: T }).json;
    }
    return payload as T;
  };

  return {
    getPublicURL: async (input) =>
      await requestJson("/api/get-public-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    service: {
      health: async () => await requestJson("/api/__iterate/health"),
      sql: async (input) =>
        await requestJson(
          "/api/__iterate/sql",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json: input }),
          },
          { orpc: true },
        ),
    },
    routes: {
      list: async () => await requestJson("/api/routes"),
      upsert: async (input) =>
        await requestJson("/api/routes/upsert", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
      remove: async (input) =>
        await requestJson("/api/routes/remove", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
      caddyLoadInvocation: async (input) =>
        await requestJson("/api/routes/caddy-load-invocation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
    },
    config: {
      get: async (input) => await requestJson(`/api/config/${encodeURIComponent(input.key)}`),
      list: async () => await requestJson("/api/config"),
      set: async (input) =>
        await requestJson(`/api/config/${encodeURIComponent(input.key)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: input.value }),
        }),
    },
  };
}
