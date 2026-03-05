import { oc } from "@orpc/contract";
import { createServiceSubRouterContract } from "@iterate-com/shared/jonasland";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };

export const Deployment = z.object({
  id: z.string(),
  provider: z.enum(["docker", "fly"]),
  slug: z.string(),
  opts: z.unknown(),
  deploymentLocator: z.unknown().nullable(),
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
} as const;

export {
  CreateDeploymentInput as createDeploymentSchema,
  SlugInput as slugInputSchema,
  FakeOsServiceEnv as fakeOsServiceEnvSchema,
};
