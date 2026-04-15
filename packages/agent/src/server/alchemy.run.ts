import { compileRawAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import alchemy, { type Scope } from "alchemy";
import { Worker } from "alchemy/cloudflare";
import { CloudflareStateStore, SQLiteStateStore } from "alchemy/state";
import { z } from "zod";
import { AppConfig } from "../app.ts";

const APP_NAME = "agent";

const AlchemyEnv = z.object({
  ALCHEMY_PASSWORD: z.string().trim().min(1, "ALCHEMY_PASSWORD is required"),
  ALCHEMY_LOCAL: z.stringbool().optional(),
  ALCHEMY_STAGE: z
    .string()
    .trim()
    .min(1, "ALCHEMY_STAGE is required")
    .regex(/^[\w-]+$/, "ALCHEMY_STAGE must contain only letters, numbers, underscores, or hyphens"),
  CLOUDFLARE_API_TOKEN: z.string().trim().min(1, "CLOUDFLARE_API_TOKEN is required"),
  CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1, "CLOUDFLARE_ACCOUNT_ID is required"),
});

const env = AlchemyEnv.parse(process.env);
const rawAppConfig = compileRawAppConfigFromEnv({
  configSchema: AppConfig,
  prefix: "APP_CONFIG_",
  env: process.env,
});

const stateStore = (scope: Scope) =>
  scope.local ? new SQLiteStateStore(scope, { engine: "libsql" }) : new CloudflareStateStore(scope);

const app = await alchemy(APP_NAME, {
  stage: env.ALCHEMY_STAGE,
  password: env.ALCHEMY_PASSWORD,
  stateStore,
  ...(env.ALCHEMY_LOCAL ? { local: true } : {}),
});

export const worker = await Worker(APP_NAME, {
  name: `${APP_NAME}-${app.stage}`,
  adopt: true,
  bindings: {
    APP_CONFIG: JSON.stringify(rawAppConfig, null, 2),
  },
  entrypoint: "./src/server/worker.ts",
});

console.dir({ url: worker.url }, { depth: null });

await app.finalize();
