import alchemy from "alchemy";
import { D1Database, TanStackStart } from "alchemy/cloudflare";
import { compileRawAppConfigFromEnv, parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { z } from "zod";
import { AppConfig } from "./src/app.ts";

const APP_NAME = "example";

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
});

const env = AlchemyEnv.parse(process.env);
const compiledAppConfig = parseAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: process.env,
});
const rawAppConfig = compileRawAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: process.env,
});

// Cursor and many test runners set CI=1. Alchemy rejects its default local
// state store in CI mode, so clear CI only for explicitly local runs.
if (env.ALCHEMY_LOCAL) delete process.env.CI;

const app = await alchemy(APP_NAME, {
  stage: env.ALCHEMY_STAGE,
  local: env.ALCHEMY_LOCAL,
  password: env.ALCHEMY_PASSWORD,
});

const workerName = `${APP_NAME}-${app.stage}`;

const db = await D1Database("example-db", {
  name: `${workerName}-db`,
  migrationsDir: "./drizzle",
  adopt: true,
});

export const worker = await TanStackStart(APP_NAME, {
  name: workerName,
  adopt: true,
  bindings: {
    DB: db,
    APP_CONFIG: JSON.stringify(rawAppConfig, null, 2),
  },
  wrangler: {
    main: "./src/entry.workerd.ts",
  },
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
  build: "pnpm exec vite build --config vite.cf.config.ts",
  dev: {
    command: "pnpm exec vite dev --config vite.cf.config.ts",
  },
});

console.log({ url: worker.url });

await app.finalize();
