import alchemy from "alchemy";
import { Assets, Worker, WranglerJson } from "alchemy/cloudflare";
import { z } from "zod";
import { WorkerEnvVars } from "./env-schema.ts";

const APP_NAME = "ws-test-2";

// Keep stage/local selection explicit in package scripts instead of hiding it in
// code defaults. That matches Alchemy's normal CLI-driven dev/deploy workflow.
// https://alchemy.run/concepts/cli
// https://alchemy.run/concepts/dev
const AlchemyEnv = z.object({
  ALCHEMY_PASSWORD: z.string().trim().min(1, "ALCHEMY_PASSWORD is required"),
  ALCHEMY_LOCAL: z.stringbool("ALCHEMY_LOCAL must be a boolean string").optional(),
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
  ...(env.ALCHEMY_LOCAL ? { local: true } : {}),
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
  // `bundle.define` is passed through to esbuild. We use it to make the worker
  // PTY branch a compile-time false branch, so the dynamic import of `./api/pty.ts`
  // is removed from the Cloudflare bundle.
  // https://alchemy.run/providers/cloudflare/worker
  // https://raw.githubusercontent.com/alchemy-run/alchemy/main/examples/cloudflare-worker/alchemy.run.ts
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
