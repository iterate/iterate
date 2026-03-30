import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { oc } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { commonContract } from "@iterate-com/shared/apps/common-router-contract";
import { z } from "zod/v4";

const RouteMetadata = z.record(z.string(), z.string());
const RouteCaddyDirectives = z.array(z.string()).default([]);

const RouteRecord = z.object({
  host: z.string(),
  target: z.string(),
  metadata: RouteMetadata.default({}),
  tags: z.array(z.string()).default([]),
  caddyDirectives: RouteCaddyDirectives,
  updatedAt: z.string(),
});

const RouteUpsertInput = z.object({
  host: z.string(),
  target: z.string(),
  metadata: RouteMetadata.optional(),
  tags: z.array(z.string()).optional(),
  caddyDirectives: z.array(z.string()).optional(),
});

const ConfigEntry = z.object({
  key: z.string(),
  value: z.unknown(),
  updatedAt: z.string(),
});

const GetPublicUrlInput = z.object({
  internalURL: z.string().min(1),
});

const GetPublicUrlOutput = z.object({
  publicURL: z.string(),
});

const SqlResultHeader = z.object({
  name: z.string(),
  displayName: z.string(),
  originalType: z.string().nullable(),
  type: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
});

const SqlResult = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  headers: z.array(SqlResultHeader),
  stat: z.object({
    rowsAffected: z.number().int(),
    rowsRead: z.number().int().nullable(),
    rowsWritten: z.number().int().nullable(),
    queryDurationMs: z.number().int().nullable(),
  }),
  lastInsertRowid: z.number().int().optional(),
});

const IngressEnvValues = z.object({
  ITERATE_INGRESS_HOST: z.string().nullable(),
  ITERATE_INGRESS_ROUTING_TYPE: z.enum(["dunder-prefix", "subdomain-host"]),
  ITERATE_INGRESS_DEFAULT_APP: z.string(),
});

const OpenApiSource = z.object({
  id: z.string(),
  title: z.string(),
  specUrl: z.string(),
  appUrl: z.string(),
});

const RegistryDbSource = z.object({
  id: z.string(),
  host: z.string(),
  title: z.string(),
  publicURL: z.string(),
  sqlitePath: z.string(),
  sqliteAlias: z.string(),
  tags: z.array(z.string()),
  updatedAt: z.string(),
});

const LandingRouteRecord = RouteRecord.extend({
  title: z.string(),
  publicURL: z.string(),
  docsURL: z.string().optional(),
  hasOpenAPI: z.boolean(),
  hasSqlite: z.boolean(),
});

const LandingData = z.object({
  ingress: IngressEnvValues,
  routes: z.array(LandingRouteRecord),
  docsSources: z.array(OpenApiSource),
  dbSources: z.array(RegistryDbSource),
});

const DbRuntimeTarget = z.object({
  alias: z.string(),
  path: z.string(),
  host: z.string().optional(),
  title: z.string().optional(),
});

const DbRuntimeInput = z.object({
  mainAlias: z.string().optional(),
});

const DbRuntimeOutput = z.object({
  studioSrc: z.string(),
  selectedMainAlias: z.string(),
  databases: z.array(DbRuntimeTarget),
  mainPath: z.string(),
  attached: z.record(z.string(), z.string()),
});

const DbQueryRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("query"),
    id: z.number().int(),
    statement: z.string().min(1),
  }),
  z.object({
    type: z.literal("transaction"),
    id: z.number().int(),
    statements: z.array(z.string().min(1)).min(1),
  }),
]);

const DbQueryInput = z.object({
  mainAlias: z.string().optional(),
  request: DbQueryRequest,
});

const DbQueryResponse = z.union([
  z.object({
    type: z.literal("query"),
    id: z.number().int(),
    data: SqlResult,
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("transaction"),
    id: z.number().int(),
    data: z.array(SqlResult),
    error: z.string().optional(),
  }),
  z.object({
    type: z.enum(["query", "transaction"]),
    id: z.number().int(),
    error: z.string(),
  }),
]);

const StartupSeedOutput = z.object({
  seededCount: z.number().int().nonnegative(),
  routeCount: z.number().int().nonnegative(),
});

const StartupInitializeInput = z
  .object({
    registryAppPort: z.number().int().min(1).max(65535).optional(),
  })
  .optional()
  .default({});

const StartupInitializeOutput = StartupSeedOutput;

export const daemonV2Contract = oc.router({
  common: commonContract,
  getPublicURL: oc
    .route({
      method: "POST",
      path: "/get-public-url",
      summary: "Convert internal URL to public URL",
      tags: ["ingress"],
    })
    .input(GetPublicUrlInput)
    .output(GetPublicUrlOutput),

  landing: {
    get: oc
      .route({
        method: "GET",
        path: "/landing",
        summary: "Get daemon-v2 landing page data",
        tags: ["landing"],
      })
      .input(z.object({}).optional().default({}))
      .output(LandingData),
  },

  docs: {
    listSources: oc
      .route({
        method: "GET",
        path: "/docs/sources",
        summary: "List OpenAPI documentation sources",
        tags: ["docs"],
      })
      .input(z.object({}).optional().default({}))
      .output(
        z.object({
          sources: z.array(OpenApiSource),
          total: z.number().int().nonnegative(),
        }),
      ),
  },

  db: {
    listSources: oc
      .route({
        method: "GET",
        path: "/db/sources",
        summary: "List sqlite databases discovered by daemon-v2",
        tags: ["db"],
      })
      .input(z.object({}).optional().default({}))
      .output(
        z.object({
          sources: z.array(RegistryDbSource),
          total: z.number().int().nonnegative(),
        }),
      ),

    runtime: oc
      .route({
        method: "GET",
        path: "/db/runtime",
        summary: "Resolve DB browser runtime configuration",
        tags: ["db"],
      })
      .input(DbRuntimeInput)
      .output(DbRuntimeOutput),

    query: oc
      .route({
        method: "POST",
        path: "/db/query",
        summary: "Execute a sqlite browser request",
        tags: ["db"],
      })
      .input(DbQueryInput)
      .output(DbQueryResponse),
  },

  routes: {
    upsert: oc
      .route({
        method: "POST",
        path: "/routes/upsert",
        summary: "Upsert route",
        tags: ["routes"],
      })
      .input(RouteUpsertInput)
      .output(
        z.object({
          route: RouteRecord,
          routeCount: z.number().int().nonnegative(),
        }),
      ),

    remove: oc
      .route({
        method: "POST",
        path: "/routes/remove",
        summary: "Remove route",
        tags: ["routes"],
      })
      .input(z.object({ host: z.string() }))
      .output(
        z.object({
          removed: z.boolean(),
          routeCount: z.number().int().nonnegative(),
        }),
      ),

    list: oc
      .route({
        method: "GET",
        path: "/routes",
        summary: "List routes",
        tags: ["routes"],
      })
      .input(z.object({}).optional().default({}))
      .output(
        z.object({
          routes: z.array(RouteRecord),
          total: z.number().int().nonnegative(),
        }),
      ),
  },

  startup: {
    seedRoutes: oc
      .route({
        method: "POST",
        path: "/startup/seed-routes",
        summary: "Seed built-in daemon-v2 routes",
        tags: ["startup"],
      })
      .input(z.object({}).optional().default({}))
      .output(StartupSeedOutput),

    initialize: oc
      .route({
        method: "POST",
        path: "/startup/initialize",
        summary: "Seed routes and optionally write a synced route fragment",
        tags: ["startup"],
      })
      .input(StartupInitializeInput)
      .output(StartupInitializeOutput),
  },

  config: {
    get: oc
      .route({
        method: "GET",
        path: "/config/{key}",
        summary: "Get config key",
        tags: ["config"],
      })
      .input(z.object({ key: z.string() }))
      .output(
        z.object({
          found: z.boolean(),
          entry: ConfigEntry.optional(),
        }),
      ),

    set: oc
      .route({
        method: "POST",
        path: "/config/{key}",
        summary: "Set config key",
        tags: ["config"],
      })
      .input(z.object({ key: z.string(), value: z.unknown() }))
      .output(z.object({ entry: ConfigEntry })),

    list: oc
      .route({
        method: "GET",
        path: "/config",
        summary: "List config entries",
        tags: ["config"],
      })
      .input(z.object({}).optional().default({}))
      .output(
        z.object({
          entries: z.array(ConfigEntry),
          total: z.number().int().nonnegative(),
        }),
      ),
  },
});

export type DaemonClient = ContractRouterClient<typeof daemonV2Contract>;
type DaemonFetch = (input: URL | string | Request, init?: RequestInit) => Promise<Response>;

export function createDaemonClient(options: { url: string; fetch?: DaemonFetch }): DaemonClient {
  const link = new OpenAPILink(daemonV2Contract, {
    url: options.url,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return createORPCClient(link);
}
