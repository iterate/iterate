import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { CaddyClient, buildHostRoute } from "@accelerated-software-development/caddy-api-client";
import {
  servicesContract,
  servicesServiceEnvSchema,
  servicesServiceManifest,
} from "@jonasland5/services-contract";
import {
  createServiceRequestLogger,
  infoFromContext,
  transformLibsqlResultSet,
  type ServiceRequestLogger,
} from "@jonasland5/shared";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { ServicesStore } from "./db.ts";

type ServicesEnv = ReturnType<typeof servicesServiceEnvSchema.parse>;

interface ServicesContext {
  requestId: string;
  serviceName: string;
  log: ServiceRequestLogger;
  store: ServicesStore;
  env: ServicesEnv;
}

function buildCaddyLoadPayload(params: {
  routes: Array<{
    host: string;
    target: string;
  }>;
  listenAddress: string;
}): Record<string, unknown> {
  const staticRoutes: unknown[] = [
    buildHostRoute({ host: "pidnap.iterate.localhost", dial: "127.0.0.1:9876" }),
    buildHostRoute({ host: "services.iterate.localhost", dial: "127.0.0.1:8777" }),
    buildHostRoute({ host: "events.iterate.localhost", dial: "127.0.0.1:19010" }),
    buildHostRoute({ host: "caddy-admin.iterate.localhost", dial: "127.0.0.1:2019" }),
  ];

  const dynamicRoutes = params.routes.map((route) =>
    buildHostRoute({
      host: route.host,
      dial: route.target,
    }),
  );

  return {
    admin: {
      listen: "0.0.0.0:2019",
      origins: ["*"],
    },
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [params.listenAddress],
            routes: [
              ...staticRoutes,
              ...dynamicRoutes,
              {
                handle: [
                  {
                    handler: "reverse_proxy",
                    upstreams: [{ dial: "127.0.0.1:19000" }],
                  },
                ],
                terminal: true,
              },
            ],
          },
        },
      },
    },
  };
}

let storePromise: Promise<ServicesStore> | null = null;
let envCache: ServicesEnv | null = null;

function getEnv() {
  envCache ??= servicesServiceEnvSchema.parse(process.env);
  return envCache;
}

async function ensureStore(): Promise<ServicesStore> {
  if (!storePromise) {
    storePromise = ServicesStore.open(getEnv().SERVICES_DB_PATH);
  }
  return await storePromise;
}

const serviceName = "jonasland5-services-service";
const os = implement(servicesContract).$context<ServicesContext>();

async function handleCaddyLoadInvocation(params: {
  input: {
    listenAddress?: string;
    adminUrl?: string;
    apply?: boolean;
  };
  context: ServicesContext;
}) {
  const listenAddress = params.input.listenAddress ?? params.context.env.CADDY_LISTEN_ADDRESS;
  const adminUrl = params.input.adminUrl ?? params.context.env.CADDY_ADMIN_URL;
  const routes = await params.context.store.listRoutes();
  const payload = buildCaddyLoadPayload({
    routes,
    listenAddress,
  });

  const invocation = {
    method: "POST" as const,
    path: "/load" as const,
    url: `${adminUrl}/load`,
    body: payload,
  };

  if (params.input.apply === true) {
    const caddy = new CaddyClient({ adminUrl });
    const response = await caddy.request(invocation.path, {
      method: invocation.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(invocation.body),
    });

    if (!response.ok) {
      throw new Error(`caddy /load failed: ${response.status} ${response.statusText}`);
    }
  }

  return {
    invocation,
    routeCount: routes.length,
    applied: params.input.apply === true,
  };
}

export const servicesRouter = os.router({
  service: {
    health: os.service.health.handler(async ({ context }) => ({
      ok: true,
      service: context.serviceName,
      version: servicesServiceManifest.version,
    })),
    sql: os.service.sql.handler(async ({ input, context }) => {
      const startedAt = Date.now();
      const result = transformLibsqlResultSet(await context.store.executeSql(input.statement));
      infoFromContext(context, "services.service.sql", {
        service: context.serviceName,
        request_id: context.requestId,
        duration_ms: Date.now() - startedAt,
        rows: result.rows.length,
      });
      return result;
    }),
  },
  routes: {
    upsert: os.routes.upsert.handler(async ({ input, context }) => {
      const route = await context.store.upsertRoute(input);
      const routes = await context.store.listRoutes();
      infoFromContext(context, "services.routes.upsert", {
        host: route.host,
        route_count: routes.length,
      });
      return {
        route,
        routeCount: routes.length,
      };
    }),
    remove: os.routes.remove.handler(async ({ input, context }) => {
      const removed = await context.store.removeRoute(input.host);
      const routes = await context.store.listRoutes();
      infoFromContext(context, "services.routes.remove", {
        host: input.host,
        removed,
        route_count: routes.length,
      });
      return {
        removed,
        routeCount: routes.length,
      };
    }),
    list: os.routes.list.handler(async ({ context }) => {
      const routes = await context.store.listRoutes();
      return {
        routes,
        total: routes.length,
      };
    }),
    caddyLoadInvocation: os.routes.caddyLoadInvocation.handler(
      async ({ input, context }) => await handleCaddyLoadInvocation({ input, context }),
    ),
  },
  caddy: {
    loadInvocation: os.caddy.loadInvocation.handler(
      async ({ input, context }) => await handleCaddyLoadInvocation({ input, context }),
    ),
  },
  config: {
    get: os.config.get.handler(async ({ input, context }) => {
      const entry = await context.store.getConfig(input.key);
      return {
        found: entry !== null,
        ...(entry ? { entry } : {}),
      };
    }),
    set: os.config.set.handler(async ({ input, context }) => {
      const entry = await context.store.setConfig({ key: input.key, value: input.value });
      return { entry };
    }),
    list: os.config.list.handler(async ({ context }) => {
      const entries = await context.store.listConfig();
      return {
        entries,
        total: entries.length,
      };
    }),
  },
});

export async function startServicesService(options?: {
  host?: string;
  port?: number;
}): Promise<{ close: () => Promise<void> }> {
  const env = getEnv();
  const host = options?.host ?? env.SERVICES_SERVICE_HOST;
  const port = options?.port ?? env.SERVICES_SERVICE_PORT;
  const store = await ensureStore();

  const handler = new RPCHandler(servicesRouter);

  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const requestLog = createServiceRequestLogger({
      requestId,
      method: req.method,
      path: req.url,
    });

    const { matched } = await handler.handle(req, res, {
      prefix: "/rpc",
      context: {
        requestId,
        serviceName,
        log: requestLog,
        store,
        env,
      },
    });

    if (!matched) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await store.close();
    },
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startServicesService().catch(() => {
    process.exit(1);
  });
}
