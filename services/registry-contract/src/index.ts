import { oc } from "@orpc/contract";
import { createServiceSubRouterContract } from "@iterate-com/shared/jonasland";
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

const publicBaseHostType = z
  .preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }, z.enum(["prefix", "subdomain"]).optional())
  .default("prefix");

export const RegistryServiceEnv = z.object({
  REGISTRY_SERVICE_HOST: nonEmptyStringWithTrimDefault("0.0.0.0"),
  REGISTRY_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(17310),
  REGISTRY_DB_PATH: nonEmptyStringWithTrimDefault("/var/lib/jonasland/registry.sqlite"),
  CADDY_ADMIN_URL: nonEmptyStringWithTrimDefault("http://127.0.0.1:2019"),
  CADDY_LISTEN_ADDRESS: nonEmptyStringWithTrimDefault(":80"),
  CADDY_CONFIG_DIR: nonEmptyStringWithTrimDefault("/home/iterate/.iterate/caddy"),
  CADDY_ROOT_CADDYFILE: nonEmptyStringWithTrimDefault("/home/iterate/.iterate/caddy/Caddyfile"),
  CADDY_BIN_PATH: nonEmptyStringWithTrimDefault("/usr/local/bin/caddy"),
  ITERATE_PUBLIC_BASE_HOST: nonEmptyStringWithTrimDefault("iterate.localhost"),
  ITERATE_PUBLIC_BASE_HOST_TYPE: publicBaseHostType,
});

export type RegistryServiceEnv = z.infer<typeof RegistryServiceEnv>;

export {
  RouteRecord as routeRecordSchema,
  RouteUpsertInput as routeUpsertInputSchema,
  ConfigEntry as configEntrySchema,
  GetPublicUrlInput as getPublicUrlInputSchema,
  GetPublicUrlOutput as getPublicUrlOutputSchema,
  RegistryServiceEnv as registryServiceEnvSchema,
};

export const registryServiceManifest = {
  name: packageJson.name,
  slug: "registry-service",
  version: packageJson.version ?? "0.0.0",
  port: 17310,
  serverEntryPoint: "services/registry-service/src/server.ts",
  orpcContract: registryContract,
  envVars: RegistryServiceEnv,
} as const;
