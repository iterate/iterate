import alchemy from "alchemy";
import { D1Database, Worker, WranglerJson } from "alchemy/cloudflare";
import { z } from "zod";
import { WorkerEnvVars } from "./env-schema.ts";

const APP_NAME = "ingress-proxy";
const AlchemyEnv = z.object({
  ALCHEMY_PASSWORD: z.string().trim().min(1, "ALCHEMY_PASSWORD is required"),
  ALCHEMY_LOCAL: z.stringbool("ALCHEMY_LOCAL must be a boolean string"),
  // ALCHEMY_STAGE becomes part of the Alchemy state scope and our provider-side
  // resource names, so we restrict it to characters that are safe in both.
  ALCHEMY_STAGE: z
    .string()
    .trim()
    .min(1, "ALCHEMY_STAGE is required")
    .regex(/^[\w-]+$/, "ALCHEMY_STAGE must contain only letters, numbers, underscores, or hyphens"),
  // These are deploy-time Cloudflare credentials for Alchemy itself. They use
  // the provider's standard names directly: no compatibility remapping.
  CLOUDFLARE_API_TOKEN: z.string().trim().min(1, "CLOUDFLARE_API_TOKEN is required"),
  CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1, "CLOUDFLARE_ACCOUNT_ID is required"),
  ...WorkerEnvVars.shape,
});
const env = AlchemyEnv.parse(process.env);

// APP_NAME is the stable app/resource prefix. app.stage scopes one deployment
// inside that app, and we prefix provider-visible names with it so dev/stg/prd
// do not collide in the same Cloudflare account.
const app = await alchemy(APP_NAME, {
  stage: env.ALCHEMY_STAGE,
  local: env.ALCHEMY_LOCAL,
  password: env.ALCHEMY_PASSWORD,
});

const workerName = `${app.stage}-${APP_NAME}`;

const db = await D1Database(`${APP_NAME}-routes`, {
  name: `${workerName}-routes`,
  migrationsDir: "./sql/migrations",
  adopt: true,
});

export const worker = await Worker(APP_NAME, {
  name: workerName,
  entrypoint: "./server.ts",
  adopt: true,
  bindings: {
    DB: db,
    INGRESS_PROXY_API_TOKEN: alchemy.secret(env.INGRESS_PROXY_API_TOKEN),
    TYPEID_PREFIX: env.TYPEID_PREFIX,
  },
  // These route patterns come directly from WORKER_ROUTES. When adding a new
  // host family, remember that deeper dotted hosts may need both:
  // 1. an explicit nested wildcard route here, and
  // 2. a matching Cloudflare edge certificate for HTTPS.
  routes: env.WORKER_ROUTES.map((pattern) => ({ pattern })),
});

// Generate wrangler.json mostly so operators can inspect the resolved
// Cloudflare config while debugging. This file is an artifact, not source of
// truth, and should not be checked into Git.
await WranglerJson({
  worker,
  path: "./wrangler.json",
});

await app.finalize();
