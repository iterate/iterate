import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { oc as ocBase } from "@orpc/contract";
import type { ContractRouterClient } from "@orpc/contract";
import { implement, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { CaddyClient, buildHostRoute } from "@accelerated-software-development/caddy-api-client";
import * as v from "valibot";

const DEFAULT_SERVICES_LISTEN_HOST = "0.0.0.0";
const DEFAULT_SERVICES_CLIENT_HOST = "127.0.0.1";
const DEFAULT_SERVICES_PORT = 8777;
const DEFAULT_CADDY_ADMIN_URL = "http://127.0.0.1:2019";
const DEFAULT_LISTEN_ADDRESS = ":80";

const RouteRecordSchema = v.object({
  host: v.string(),
  target: v.string(),
  metadata: v.optional(v.record(v.string(), v.string())),
});

const LoadInvocationSchema = v.object({
  method: v.literal("POST"),
  path: v.literal("/load"),
  url: v.string(),
  body: v.unknown(),
});

const oc = ocBase.$input(v.void());

export const servicesApi = {
  routes: {
    upsert: oc
      .input(RouteRecordSchema)
      .output(v.object({ route: RouteRecordSchema, routeCount: v.number() })),
    remove: oc
      .input(v.object({ host: v.string() }))
      .output(v.object({ removed: v.boolean(), routeCount: v.number() })),
    caddyLoadInvocation: oc
      .input(
        v.object({
          listenAddress: v.optional(v.string()),
          adminUrl: v.optional(v.string()),
          apply: v.optional(v.boolean()),
        }),
      )
      .output(
        v.object({
          invocation: LoadInvocationSchema,
          routeCount: v.number(),
          applied: v.boolean(),
        }),
      ),
  },
};

type RouteRecord = v.InferOutput<typeof RouteRecordSchema>;

class InMemoryRouteStore {
  private readonly routesByHost = new Map<string, RouteRecord>();

  upsert(route: RouteRecord): { route: RouteRecord; routeCount: number } {
    const normalized: RouteRecord = {
      host: normalizeHost(route.host),
      target: route.target,
      ...(route.metadata ? { metadata: route.metadata } : {}),
    };
    this.routesByHost.set(normalized.host, normalized);
    return { route: normalized, routeCount: this.routesByHost.size };
  }

  remove(host: string): { removed: boolean; routeCount: number } {
    const removed = this.routesByHost.delete(normalizeHost(host));
    return { removed, routeCount: this.routesByHost.size };
  }

  list(): RouteRecord[] {
    return Array.from(this.routesByHost.values()).sort((a, b) => a.host.localeCompare(b.host));
  }
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function buildCaddyLoadPayload(params: {
  routes: RouteRecord[];
  listenAddress: string;
}): Record<string, unknown> {
  const generatedRoutes = params.routes.map((route) =>
    buildHostRoute({
      host: route.host,
      dial: route.target,
    }),
  );

  return {
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [params.listenAddress],
            routes: generatedRoutes,
          },
        },
      },
    },
  };
}

const os = implement(servicesApi).$context<{ store: InMemoryRouteStore }>();

export const servicesRouter = os.router({
  routes: {
    upsert: os.routes.upsert.handler(async ({ input, context }) => {
      return context.store.upsert(input);
    }),
    remove: os.routes.remove.handler(async ({ input, context }) => {
      return context.store.remove(input.host);
    }),
    caddyLoadInvocation: os.routes.caddyLoadInvocation.handler(async ({ input, context }) => {
      const listenAddress = input.listenAddress ?? DEFAULT_LISTEN_ADDRESS;
      const adminUrl = input.adminUrl ?? DEFAULT_CADDY_ADMIN_URL;
      const payload = buildCaddyLoadPayload({
        routes: context.store.list(),
        listenAddress,
      });

      const invocation = {
        method: "POST" as const,
        path: "/load" as const,
        url: `${adminUrl}/load`,
        body: payload,
      };

      if (input.apply === true) {
        const caddy = new CaddyClient({ adminUrl });
        await caddy.request(invocation.path, {
          method: invocation.method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(invocation.body),
        });
      }

      return {
        invocation,
        routeCount: context.store.list().length,
        applied: input.apply === true,
      };
    }),
  },
});

export type ServicesClient = ContractRouterClient<typeof servicesApi>;

export function createServicesClient(params?: {
  url?: string;
  fetch?: (request: Request) => Promise<Response>;
}): ServicesClient {
  const url =
    params?.url ?? `http://${DEFAULT_SERVICES_CLIENT_HOST}:${String(DEFAULT_SERVICES_PORT)}/rpc`;
  const link = new RPCLink({ url, ...(params?.fetch ? { fetch: params.fetch } : {}) });
  return createORPCClient(link);
}

export async function startServicesService(options?: {
  host?: string;
  port?: number;
}): Promise<{ close: () => Promise<void> }> {
  const host = options?.host ?? DEFAULT_SERVICES_LISTEN_HOST;
  const port = options?.port ?? DEFAULT_SERVICES_PORT;
  const store = new InMemoryRouteStore();
  const handler = new RPCHandler(servicesRouter, {
    interceptors: [
      onError((error) => {
        console.error("[services-service] ORPC error", error);
      }),
    ],
  });

  const server = createServer(async (req, res) => {
    const { matched } = await handler.handle(req, res, {
      prefix: "/rpc",
      context: { store },
    });
    if (!matched) {
      res.writeHead(404).end();
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });

  console.log(`[services-service] listening on http://${host}:${String(port)}/rpc`);

  return {
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startServicesService().catch((error) => {
    console.error("[services-service] fatal error", error);
    process.exit(1);
  });
}
