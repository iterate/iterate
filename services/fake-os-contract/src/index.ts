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

export const DeploymentLogEntry = z.object({
  text: z.string(),
  timestamp: z.string().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

export const PidnapManagerStatus = z.object({
  state: z.enum(["idle", "running", "stopping", "stopped"]),
  processCount: z.number(),
});

export const PidnapProcessDefinition = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  inheritProcessEnv: z.boolean().optional(),
});

export const PidnapProcess = z.object({
  name: z.string(),
  tags: z.array(z.string()),
  state: z.enum([
    "idle",
    "running",
    "restarting",
    "stopping",
    "stopped",
    "crash-loop-backoff",
    "max-restarts-reached",
  ]),
  restarts: z.number(),
  definition: PidnapProcessDefinition,
  effectiveEnv: z.record(z.string(), z.string()).optional(),
});

export const PidnapLogEntry = z.object({
  text: z.string(),
});

export const DeploymentServiceRegistration = z.object({
  host: z.string(),
  target: z.string(),
  targetHost: z.string(),
  targetPort: z.number().int().nonnegative().nullable(),
  metadata: z.record(z.string(), z.string()),
  tags: z.array(z.string()),
  updatedAt: z.string(),
});

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
export const DeploymentPidnapProcessInput = z.object({
  slug: z.string(),
  processSlug: z.string(),
});

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
    logs: oc
      .route({
        method: "GET",
        path: "/deployments/{slug}/logs",
        summary: "Stream deployment runtime logs",
      })
      .input(SlugInput)
      .output(eventIterator(DeploymentLogEntry)),
    pidnap: {
      status: oc
        .route({
          method: "GET",
          path: "/deployments/{slug}/pidnap/status",
          summary: "Get pidnap manager status for a deployment",
        })
        .input(SlugInput)
        .output(PidnapManagerStatus),
      processes: oc
        .route({
          method: "GET",
          path: "/deployments/{slug}/pidnap/processes",
          summary: "List pidnap processes for a deployment",
        })
        .input(SlugInput)
        .output(z.array(PidnapProcess)),
      restart: oc
        .route({
          method: "POST",
          path: "/deployments/{slug}/pidnap/processes/{processSlug}/restart",
          summary: "Restart a pidnap process for a deployment",
        })
        .input(DeploymentPidnapProcessInput)
        .output(PidnapProcess),
      logs: oc
        .route({
          method: "GET",
          path: "/deployments/{slug}/pidnap/processes/{processSlug}/logs",
          summary: "Stream pidnap process logs for a deployment",
        })
        .input(DeploymentPidnapProcessInput)
        .output(eventIterator(PidnapLogEntry)),
    },
    services: {
      list: oc
        .route({
          method: "GET",
          path: "/deployments/{slug}/services",
          summary: "List registry service registrations for a deployment",
        })
        .input(SlugInput)
        .output(z.array(DeploymentServiceRegistration)),
    },
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
export type DeploymentLogEntry = z.infer<typeof DeploymentLogEntry>;
export type PidnapManagerStatus = z.infer<typeof PidnapManagerStatus>;
export type PidnapProcess = z.infer<typeof PidnapProcess>;
export type PidnapLogEntry = z.infer<typeof PidnapLogEntry>;
export type DeploymentServiceRegistration = z.infer<typeof DeploymentServiceRegistration>;
