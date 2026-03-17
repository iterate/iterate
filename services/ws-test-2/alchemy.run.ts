import alchemy from "alchemy";
import { Assets, Worker, WranglerJson } from "alchemy/cloudflare";
import { z } from "zod";
import { WorkerEnvVars } from "./env-schema.ts";

const APP_NAME = "ws-test-2";
const AlchemyEnv = z.object({
  ALCHEMY_PASSWORD: z.string().trim().min(1, "ALCHEMY_PASSWORD is required"),
  ALCHEMY_LOCAL: z.stringbool("ALCHEMY_LOCAL must be a boolean string"),
  ALCHEMY_STAGE: z
    .string()
    .trim()
    .min(1, "ALCHEMY_STAGE is required")
    .regex(/^[\w-]+$/, "ALCHEMY_STAGE must contain only letters, numbers, underscores, or hyphens"),
  CLOUDFLARE_API_TOKEN: z.string().trim().min(1, "CLOUDFLARE_API_TOKEN is required"),
  CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1, "CLOUDFLARE_ACCOUNT_ID is required"),
  ...WorkerEnvVars.shape,
});

const env = AlchemyEnv.parse(process.env);

const app = await alchemy(APP_NAME, {
  stage: env.ALCHEMY_STAGE,
  local: env.ALCHEMY_LOCAL,
  password: env.ALCHEMY_PASSWORD,
});

const workerName = `${app.stage}-${APP_NAME}`;
const assets = await Assets({
  path: "./dist/client",
});

export const worker = await Worker(APP_NAME, {
  name: workerName,
  entrypoint: "./src/worker.ts",
  adopt: true,
  url: true,
  bindings: {
    ASSETS: assets,
  },
  bundle: {
    define: {
      ENABLE_PTY: env.ENABLE_PTY ? "true" : "false",
    },
  },
  routes: env.WORKER_ROUTES.map((pattern) => ({ pattern })),
});

await WranglerJson({
  worker,
  path: "./wrangler.json",
});

await app.finalize();
