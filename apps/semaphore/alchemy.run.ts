import alchemy, { type Scope } from "alchemy";
import { D1Database, DurableObjectNamespace, TanStackStart } from "alchemy/cloudflare";
import { CloudflareStateStore, SQLiteStateStore } from "alchemy/state";
import { compileRawAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { slugify } from "@iterate-com/shared/slugify";
import { z } from "zod";
import { AppConfig } from "./src/app.ts";
import type { ResourceCoordinator } from "~/durable-objects/resource-coordinator.ts";

const APP_NAME = "semaphore";

const AlchemyEnv = z.object({
  ALCHEMY_PASSWORD: z.string().trim().min(1, "ALCHEMY_PASSWORD is required"),
  ALCHEMY_LOCAL: z.stringbool(),
  ALCHEMY_STAGE: z
    .string()
    .trim()
    .min(1, "ALCHEMY_STAGE is required")
    .regex(/^[\w-]+$/, "ALCHEMY_STAGE must contain only letters, numbers, underscores, or hyphens"),
  CLOUDFLARE_API_TOKEN: z.string().trim().min(1, "CLOUDFLARE_API_TOKEN is required"),
  CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1, "CLOUDFLARE_ACCOUNT_ID is required"),
  WORKER_ROUTES: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .map((entry) => entry.replace(/\/\*$/, ""))
        .filter(Boolean),
    )
    .pipe(
      z.array(
        z
          .string()
          .min(1)
          .refine(
            (hostname) => !hostname.includes("/") && !hostname.includes("://"),
            "WORKER_ROUTES entries must be hostnames without scheme or path",
          ),
      ),
    ),
});

const env = AlchemyEnv.parse(process.env);
const stateStore = (scope: Scope) =>
  scope.local ? new SQLiteStateStore(scope, { engine: "libsql" }) : new CloudflareStateStore(scope);
const rawAppConfig = compileRawAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: process.env,
});

if (env.ALCHEMY_LOCAL) delete process.env.CI;

const app = await alchemy(APP_NAME, {
  stage: env.ALCHEMY_STAGE,
  local: env.ALCHEMY_LOCAL,
  password: env.ALCHEMY_PASSWORD,
  stateStore,
});

const workerName = slugify(`${APP_NAME}-${app.stage}`);
const primaryUrl = env.WORKER_ROUTES[0] ? `https://${env.WORKER_ROUTES[0]}` : undefined;

const db = await D1Database("resources-db", {
  name: `${workerName}-resources`,
  migrationsDir: "./migrations",
  adopt: true,
});

const coordinator = DurableObjectNamespace<ResourceCoordinator>("resource-coordinator", {
  className: "ResourceCoordinator",
  sqlite: true,
});

export const worker = await TanStackStart(APP_NAME, {
  name: workerName,
  adopt: true,
  bindings: {
    DB: db,
    RESOURCE_COORDINATOR: coordinator,
    APP_CONFIG: alchemy.secret(JSON.stringify(rawAppConfig, null, 2)),
  },
  wrangler: {
    main: "./src/entry.workerd.ts",
  },
  routes: env.WORKER_ROUTES.map((hostname) => ({
    pattern: `${hostname}/*`,
    adopt: true,
  })),
  observability: {
    enabled: true,
    headSamplingRate: 1,
    logs: {
      enabled: true,
      headSamplingRate: 1,
      persist: true,
      invocationLogs: true,
    },
    traces: {
      enabled: true,
      persist: true,
      headSamplingRate: 1,
    },
  },
  build: "pnpm exec vite build",
  dev: {
    command: "pnpm exec vite dev",
  },
});

console.log({ url: primaryUrl ?? worker.url, workersDevUrl: worker.url });

await app.finalize();
