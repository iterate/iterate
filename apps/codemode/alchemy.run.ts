import alchemy, { type Scope } from "alchemy";
import { D1Database, TanStackStart, Worker, WorkerLoader } from "alchemy/cloudflare";
import { CloudflareStateStore, SQLiteStateStore } from "alchemy/state";
import { compileRawAppConfigFromEnv, parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { slugify } from "@iterate-com/shared/slugify";
import { z } from "zod";
import { AppConfig } from "./src/app.ts";

const APP_NAME = "codemode";

const AlchemyEnv = z.object({
  ALCHEMY_PASSWORD: z.string().trim().min(1, "ALCHEMY_PASSWORD is required"),
  ALCHEMY_LOCAL: z.stringbool(),
  ALCHEMY_STAGE: z
    .string()
    .trim()
    .min(1, "ALCHEMY_STAGE is required")
    .regex(/^[\w-]+$/, "ALCHEMY_STAGE must contain only letters, numbers, underscores, or hyphens"),
  WORKER_ROUTES: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
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
  CLOUDFLARE_API_TOKEN: z.string().trim().min(1, "CLOUDFLARE_API_TOKEN is required"),
  CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1, "CLOUDFLARE_ACCOUNT_ID is required"),
});

const env = AlchemyEnv.parse(process.env);
const stateStore = (scope: Scope) =>
  scope.local ? new SQLiteStateStore(scope, { engine: "libsql" }) : new CloudflareStateStore(scope);
const primaryUrl = env.WORKER_ROUTES[0] ? `https://${env.WORKER_ROUTES[0]}` : undefined;
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

if (env.ALCHEMY_LOCAL) delete process.env.CI;

const app = await alchemy(APP_NAME, {
  stage: env.ALCHEMY_STAGE,
  local: env.ALCHEMY_LOCAL,
  password: env.ALCHEMY_PASSWORD,
  stateStore,
});

const workerName = slugify(`${APP_NAME}-${app.stage}`);

const db = await D1Database("codemode-db", {
  name: `${workerName}-db`,
  migrationsDir: "./drizzle",
  adopt: true,
});

const outboundWorker = await Worker("codemode-outbound", {
  name: `${workerName}-outbound`,
  adopt: true,
  compatibilityFlags: ["global_fetch_strictly_public"],
  bindings: {
    DB: db,
  },
  entrypoint: "./src/outbound-worker.ts",
});

export const worker = await TanStackStart(APP_NAME, {
  name: workerName,
  adopt: true,
  compatibilityFlags: ["global_fetch_strictly_public"],
  bindings: {
    APP_CONFIG: alchemy.secret(JSON.stringify(rawAppConfig, null, 2)),
    DB: db,
    LOADER: WorkerLoader(),
    OUTBOUND: outboundWorker,
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
  build: "pnpm exec vite build --config vite.cf.config.ts",
  dev: {
    command: "pnpm exec vite dev --config vite.cf.config.ts",
  },
});

console.dir(
  {
    config: compiledAppConfig,
    url: primaryUrl ?? worker.url,
    workersDevUrl: worker.url,
  },
  { depth: null },
);

await app.finalize();
