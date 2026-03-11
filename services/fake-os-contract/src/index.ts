import { eventIterator, oc } from "@orpc/contract";
import { createServiceSubRouterContract } from "@iterate-com/shared/jonasland/service-contract";
import type { ServiceManifestWithEntryPoint } from "@iterate-com/shared/jonasland/service-contract";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };

export const DeploymentRuntime = z.object({
  state: z.enum(["pending", "connecting", "connected", "disconnected", "destroying", "destroyed"]),
  baseUrl: z.string().nullable(),
  providerStatus: z
    .object({
      state: z.enum(["unknown", "running", "starting", "stopped", "destroyed", "error"]),
      detail: z.string(),
    })
    .nullable(),
});

export const DeploymentEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("https://events.iterate.com/deployment/created"),
    payload: z.object({
      baseUrl: z.string(),
      locator: z.unknown(),
    }),
  }),
  z.object({
    type: z.literal("https://events.iterate.com/deployment/started"),
    payload: z.object({
      detail: z.string(),
    }),
  }),
  z.object({
    type: z.literal("https://events.iterate.com/deployment/stopped"),
    payload: z.object({
      detail: z.string(),
    }),
  }),
  z.object({
    type: z.literal("https://events.iterate.com/deployment/logged"),
    payload: z.object({
      line: z.string(),
      providerData: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  z.object({
    type: z.literal("https://events.iterate.com/deployment/errored"),
    payload: z.object({
      message: z.string(),
    }),
  }),
  z.object({
    type: z.literal("https://events.iterate.com/deployment/destroyed"),
    payload: z.object({}),
  }),
]);

export const Deployment = z.object({
  id: z.string(),
  provider: z.enum(["docker", "fly"]),
  slug: z.string(),
  opts: z.unknown(),
  deploymentLocator: z.unknown().nullable(),
  runtime: DeploymentRuntime.nullable(),
  createdAt: z.coerce.date().nullable(),
});

export const CreateDeploymentInput = z.object({
  provider: z.enum(["docker", "fly"]),
  slug: z
    .string()
    .min(1, "Slug is required")
    .regex(/^[a-z0-9-]+$/, "Lowercase alphanumeric and hyphens only"),
  opts: z.string().transform((s, ctx) => {
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid JSON" });
      return z.NEVER;
    }
  }),
});

export const SlugInput = z.object({ slug: z.string() });

const serviceSubRouter = createServiceSubRouterContract({
  healthSummary: "fake-os service health metadata",
  sqlSummary: "Execute SQL against fake-os sqlite database",
});

export const fakeOsContract = oc.router({
  ...serviceSubRouter,
  deployments: {
    list: oc
      .route({ method: "GET", path: "/deployments", summary: "List deployments" })
      .output(z.array(Deployment)),
    get: oc
      .route({ method: "GET", path: "/deployments/{slug}", summary: "Get deployment by slug" })
      .input(SlugInput)
      .output(Deployment),
    create: oc
      .route({ method: "POST", path: "/deployments", summary: "Create deployment" })
      .input(CreateDeploymentInput)
      .output(Deployment),
    events: oc
      .route({
        method: "GET",
        path: "/deployments/{slug}/events",
        summary: "Stream deployment runtime events",
      })
      .input(SlugInput)
      .output(eventIterator(DeploymentEvent)),
    delete: oc
      .route({ method: "DELETE", path: "/deployments/{slug}", summary: "Delete deployment" })
      .input(SlugInput)
      .output(z.object({ ok: z.literal(true) })),
  },
});

export const FakeOsServiceEnv = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3100),
  DATABASE_URL: z.string().default("./data/fake-os.db"),
});

export const fakeOsServiceManifest = {
  name: packageJson.name,
  slug: "fake-os",
  version: packageJson.version ?? "0.0.0",
  port: 3100,
  serverEntryPoint: "services/fake-os/server.ts",
  orpcContract: fakeOsContract,
  envVars: FakeOsServiceEnv,
} as const satisfies ServiceManifestWithEntryPoint;

export {
  CreateDeploymentInput as createDeploymentSchema,
  SlugInput as slugInputSchema,
  FakeOsServiceEnv as fakeOsServiceEnvSchema,
};

export type DeploymentRuntime = z.infer<typeof DeploymentRuntime>;
export type Deployment = z.infer<typeof Deployment>;
export type DeploymentEvent = z.infer<typeof DeploymentEvent>;
