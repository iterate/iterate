import { oc } from "@orpc/contract";
import {
  ServiceSqlResult,
  createServiceSubRouterContract,
} from "@iterate-com/shared/jonasland/service-contract";
import type { ServiceManifestWithEntryPoint } from "@iterate-com/shared/jonasland/service-contract";
import { z } from "zod/v4";
import packageJson from "../package.json" with { type: "json" };

const RouteMetadata = z.record(z.string(), z.string());
const RouteCaddyDirectives = z.array(z.string()).default([]);

export const RouteRecord = z.object({
  host: z.string(),
  target: z.string(),
  metadata: RouteMetadata.default({}),
  tags: z.array(z.string()).default([]),
  caddyDirectives: RouteCaddyDirectives,
  updatedAt: z.string(),
});

export const RouteUpsertInput = z.object({
  host: z.string(),
  target: z.string(),
  metadata: RouteMetadata.optional(),
  tags: z.array(z.string()).optional(),
  caddyDirectives: z.array(z.string()).optional(),
});

export const ConfigEntry = z.object({
  key: z.string(),
  value: z.unknown(),
  updatedAt: z.string(),
});

export const GetPublicUrlInput = z.object({
  internalURL: z.string().min(1),
});

export const GetPublicUrlOutput = z.object({
  publicURL: z.string(),
});

export const IngressEnvValues = z.object({
  ITERATE_INGRESS_HOST: z.string().nullable(),
  ITERATE_INGRESS_ROUTING_TYPE: z.enum(["dunder-prefix", "subdomain-host"]),
  ITERATE_INGRESS_DEFAULT_SERVICE: z.string(),
});

export const OpenApiSource = z.object({
  id: z.string(),
  title: z.string(),
  specUrl: z.string(),
  serviceUrl: z.string(),
});

export const RegistryDbSource = z.object({
  id: z.string(),
  host: z.string(),
  title: z.string(),
  publicURL: z.string(),
  sqlitePath: z.string(),
  sqliteAlias: z.string(),
  tags: z.array(z.string()),
  updatedAt: z.string(),
});

export const LandingRouteRecord = RouteRecord.extend({
  title: z.string(),
  publicURL: z.string(),
  docsURL: z.string().optional(),
  hasOpenAPI: z.boolean(),
  hasSqlite: z.boolean(),
});

export const LandingData = z.object({
  ingress: IngressEnvValues,
  routes: z.array(LandingRouteRecord),
  docsSources: z.array(OpenApiSource),
  dbSources: z.array(RegistryDbSource),
});

export const DbRuntimeTarget = z.object({
  alias: z.string(),
  path: z.string(),
  host: z.string().optional(),
  title: z.string().optional(),
});

export const DbRuntimeInput = z.object({
  mainAlias: z.string().optional(),
});

export const DbRuntimeOutput = z.object({
  studioSrc: z.string(),
  selectedMainAlias: z.string(),
  databases: z.array(DbRuntimeTarget),
  mainPath: z.string(),
  attached: z.record(z.string(), z.string()),
});

export const DbQueryRequest = z.discriminatedUnion("type", [
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

export const DbQueryInput = z.object({
  mainAlias: z.string().optional(),
  request: DbQueryRequest,
});

export const DbQueryResponse = z.union([
  z.object({
    type: z.literal("query"),
    id: z.number().int(),
    data: ServiceSqlResult,
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("transaction"),
    id: z.number().int(),
    data: z.array(ServiceSqlResult),
    error: z.string().optional(),
  }),
  z.object({
    type: z.enum(["query", "transaction"]),
    id: z.number().int(),
    error: z.string(),
  }),
]);

const serviceSubRouter = createServiceSubRouterContract({
  healthSummary: "Registry service health metadata",
  sqlSummary: "Execute SQL against registry sqlite database",
});

export const registryContract = oc.router({
  ...serviceSubRouter,
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
        summary: "Get registry landing page data",
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
        summary: "List sqlite databases discovered by the registry",
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

    caddyLoadInvocation: oc
      .route({
        method: "POST",
        path: "/routes/caddy-load-invocation",
        summary: "Generate and optionally apply Caddy /load payload",
        tags: ["routes", "caddy"],
      })
      .input(
        z.object({
          listenAddress: z.string().optional(),
          adminUrl: z.string().optional(),
          apply: z.boolean().optional(),
        }),
      )
      .output(
        z.object({
          invocation: z.object({
            method: z.literal("POST"),
            path: z.literal("/load"),
            url: z.string(),
            body: z.unknown(),
          }),
          routeCount: z.number().int().nonnegative(),
          applied: z.boolean(),
        }),
      ),
  },

  caddy: {
    loadInvocation: oc
      .route({
        method: "POST",
        path: "/caddy/load-invocation",
        summary: "Alias for routes.caddyLoadInvocation",
        tags: ["caddy"],
      })
      .input(
        z.object({
          listenAddress: z.string().optional(),
          adminUrl: z.string().optional(),
          apply: z.boolean().optional(),
        }),
      )
      .output(
        z.object({
          invocation: z.object({
            method: z.literal("POST"),
            path: z.literal("/load"),
            url: z.string(),
            body: z.unknown(),
          }),
          routeCount: z.number().int().nonnegative(),
          applied: z.boolean(),
        }),
      ),
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

const nonEmptyStringWithTrimDefault = (defaultValue: string) =>
  z
    .preprocess((value) => {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    }, z.string().min(1).optional())
    .default(defaultValue);

const _optionalNonEmptyStringWithTrim = () =>
  z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }, z.string().min(1).optional());

const ingressRoutingType = z
  .preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }, z.enum(["dunder-prefix", "subdomain-host"]).optional())
  .default("subdomain-host");

export const RegistryServiceEnv = z.object({
  REGISTRY_SERVICE_HOST: nonEmptyStringWithTrimDefault("0.0.0.0"),
  REGISTRY_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(17310),
  REGISTRY_DB_PATH: nonEmptyStringWithTrimDefault("/var/lib/jonasland/registry.sqlite"),
  REGISTRY_DB_STUDIO_EMBED_URL: nonEmptyStringWithTrimDefault(
    "https://studio.outerbase.com/embed/sqlite",
  ),
  REGISTRY_DB_STUDIO_NAME: nonEmptyStringWithTrimDefault("jonasland sqlite"),
  REGISTRY_DB_BASIC_AUTH_USER: _optionalNonEmptyStringWithTrim(),
  REGISTRY_DB_BASIC_AUTH_PASS: z.string().default(""),
  ITERATE_INGRESS_HOST: nonEmptyStringWithTrimDefault("iterate.localhost"),
  ITERATE_INGRESS_ROUTING_TYPE: ingressRoutingType,
  ITERATE_INGRESS_DEFAULT_SERVICE: nonEmptyStringWithTrimDefault("registry"),
});

export type RegistryServiceEnv = z.infer<typeof RegistryServiceEnv>;

export {
  RouteRecord as routeRecordSchema,
  RouteUpsertInput as routeUpsertInputSchema,
  ConfigEntry as configEntrySchema,
  GetPublicUrlInput as getPublicUrlInputSchema,
  GetPublicUrlOutput as getPublicUrlOutputSchema,
  IngressEnvValues as ingressEnvValuesSchema,
  OpenApiSource as openApiSourceSchema,
  RegistryDbSource as registryDbSourceSchema,
  LandingRouteRecord as landingRouteRecordSchema,
  LandingData as landingDataSchema,
  DbRuntimeTarget as dbRuntimeTargetSchema,
  DbRuntimeInput as dbRuntimeInputSchema,
  DbRuntimeOutput as dbRuntimeOutputSchema,
  DbQueryRequest as dbQueryRequestSchema,
  DbQueryInput as dbQueryInputSchema,
  DbQueryResponse as dbQueryResponseSchema,
  RegistryServiceEnv as registryServiceEnvSchema,
};

export const registryServiceManifest = {
  name: packageJson.name,
  slug: "registry",
  version: packageJson.version ?? "0.0.0",
  port: 17310,
  serverEntryPoint: "services/registry/src/server.ts",
  orpcContract: registryContract,
  envVars: RegistryServiceEnv,
} as const satisfies ServiceManifestWithEntryPoint;
