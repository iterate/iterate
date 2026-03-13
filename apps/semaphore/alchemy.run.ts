import alchemy from "alchemy";
import { D1Database, DurableObjectNamespace, Worker, WranglerJson } from "alchemy/cloudflare";
import { z } from "zod/v4";

const Env = z.object({
  ALCHEMY_PASSWORD: z.string().optional(),
  WORKER_NAME: z.string().trim().min(1, "WORKER_NAME is required"),
  SEMAPHORE_API_TOKEN: z.string().trim().min(1, "SEMAPHORE_API_TOKEN is required"),
});

const env = Env.parse(process.env);
const wranglerJsonPath = "./wrangler.jsonc";
const compatibilityDate = "2025-02-24";

const app = await alchemy("semaphore", {
  password: env.ALCHEMY_PASSWORD,
});

const db = await D1Database("resources-db", {
  name: `${env.WORKER_NAME}-resources`,
  migrationsDir: "./migrations",
  adopt: true,
});

const coordinator = DurableObjectNamespace<import("./server.ts").ResourceCoordinator>(
  "resource-coordinator",
  {
    className: "ResourceCoordinator",
    sqlite: true,
  },
);

export const worker = await Worker("worker", {
  name: env.WORKER_NAME,
  entrypoint: "./server.ts",
  compatibilityDate,
  bindings: {
    DB: db,
    RESOURCE_COORDINATOR: coordinator,
    SEMAPHORE_API_TOKEN: alchemy.secret(env.SEMAPHORE_API_TOKEN),
  },
  adopt: true,
});

await WranglerJson({
  worker,
  path: wranglerJsonPath,
  secrets: false,
  transform: {
    wrangler: (spec) => ({
      ...spec,
      vars: {
        ...(spec.vars ?? {}),
        SEMAPHORE_API_TOKEN: "test-token",
      },
    }),
  },
});

console.log(worker.url);

await app.finalize();
