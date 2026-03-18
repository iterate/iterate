import alchemy from "alchemy";
import { Assets, D1Database, Worker, WranglerJson } from "alchemy/cloudflare";
import { z } from "zod";
import { ExampleAppEnv } from "../env.ts";
import { appManifest } from "../manifest.ts";

const APP_NAME = appManifest.slug;

const AlchemyEnv = ExampleAppEnv.extend({
  ALCHEMY_PASSWORD: z.string().trim().min(1, "ALCHEMY_PASSWORD is required"),
  ALCHEMY_LOCAL: z.stringbool("ALCHEMY_LOCAL must be a boolean string").optional(),
  ALCHEMY_STAGE: z
    .string()
    .trim()
    .min(1, "ALCHEMY_STAGE is required")
    .regex(/^[\w-]+$/, "ALCHEMY_STAGE must contain only letters, numbers, underscores, or hyphens"),
  CLOUDFLARE_API_TOKEN: z.string().trim().min(1, "CLOUDFLARE_API_TOKEN is required"),
  CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1, "CLOUDFLARE_ACCOUNT_ID is required"),
  WORKER_ROUTES: z
    .string()
    .trim()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [],
    ),
});

const env = AlchemyEnv.parse(process.env);

const app = await alchemy(APP_NAME, {
  stage: env.ALCHEMY_STAGE,
  ...(env.ALCHEMY_LOCAL ? { local: true } : {}),
  password: env.ALCHEMY_PASSWORD,
});

const workerName = `${app.stage}-${APP_NAME}`;

const db = await D1Database("example-db", {
  name: `${workerName}-db`,
  migrationsDir: "./drizzle",
  adopt: true,
});

const assets = await Assets({
  path: "./dist/client",
});

export const worker = await Worker(APP_NAME, {
  name: workerName,
  entrypoint: "./src/cloudflare/worker.ts",
  adopt: true,
  url: true,
  compatibility: "node",
  assets: {
    not_found_handling: "single-page-application",
    run_worker_first: ["/api/*"],
  },
  bindings: {
    DB: db,
    ASSETS: assets,
    VITE_POSTHOG_PUBLIC_KEY: env.VITE_POSTHOG_PUBLIC_KEY,
    VITE_POSTHOG_PROXY_URL: env.VITE_POSTHOG_PROXY_URL,
    CONFETTI_DELAY_MS: String(env.CONFETTI_DELAY_MS),
    PIRATE_SECRET: alchemy.secret(env.PIRATE_SECRET),
  },
  routes: env.WORKER_ROUTES.map((pattern) => ({ pattern })),
});

await app.finalize();
