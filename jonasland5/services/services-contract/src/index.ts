import { oc } from "@orpc/contract";
import { createServiceSubRouterContract } from "@jonasland5/shared";
import { z } from "zod/v4";
import packageJson from "../package.json" with { type: "json" };

const routeMetadataSchema = z.record(z.string(), z.string());

export const routeRecordSchema = z.object({
  host: z.string(),
  target: z.string(),
  metadata: routeMetadataSchema.default({}),
  tags: z.array(z.string()).default([]),
  updatedAt: z.string(),
});

export const routeUpsertInputSchema = z.object({
  host: z.string(),
  target: z.string(),
  metadata: routeMetadataSchema.optional(),
  tags: z.array(z.string()).optional(),
});

export const configEntrySchema = z.object({
  key: z.string(),
  value: z.unknown(),
  updatedAt: z.string(),
});

const serviceSubRouter = createServiceSubRouterContract({
  healthSummary: "Services service health metadata",
  sqlSummary: "Execute SQL against services sqlite database",
});

export const servicesContract = oc.router({
  ...serviceSubRouter,
  routes: {
    upsert: oc
      .route({
        method: "POST",
        path: "/routes/upsert",
        summary: "Upsert route",
        tags: ["routes"],
      })
      .input(routeUpsertInputSchema)
      .output(
        z.object({
          route: routeRecordSchema,
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
          routes: z.array(routeRecordSchema),
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
          entry: configEntrySchema.optional(),
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
      .output(z.object({ entry: configEntrySchema })),

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
          entries: z.array(configEntrySchema),
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

export const servicesServiceEnvSchema = z.object({
  SERVICES_SERVICE_HOST: nonEmptyStringWithTrimDefault("0.0.0.0"),
  SERVICES_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(8777),
  SERVICES_DB_PATH: nonEmptyStringWithTrimDefault("/var/lib/jonasland5/services.sqlite"),
  CADDY_ADMIN_URL: nonEmptyStringWithTrimDefault("http://127.0.0.1:2019"),
  CADDY_LISTEN_ADDRESS: nonEmptyStringWithTrimDefault(":80"),
});

export type ServicesServiceEnv = z.infer<typeof servicesServiceEnvSchema>;

export const servicesServiceManifest = {
  name: packageJson.name,
  slug: "services-service",
  version: packageJson.version ?? "0.0.0",
  port: 8777,
  orpcContract: servicesContract,
  envVars: servicesServiceEnvSchema,
} as const;
