import { z } from "zod/v4";
import alchemy from "alchemy";
import { D1Database, Worker } from "alchemy/cloudflare";

const Config = z.object({
  WORKER_NAME: z.string().min(1),
  INGRESS_PROXY_API_TOKEN: z
    .string()
    .min(1, "INGRESS_PROXY_API_TOKEN or CF_PROXY_WORKER_API_TOKEN is required"),
  TYPEID_PREFIX: z
    .string()
    .regex(/^[a-z]+$/, "TYPEID_PREFIX must contain lowercase letters only")
    .default("ipr"),
  INGRESS_PROXY_ROUTE_PATTERN: z.string().optional(),
  INGRESS_PROXY_ROUTE_ZONE_ID: z.string().optional(),
});

const config = Config.parse({
  WORKER_NAME: process.env.WORKER_NAME,
  INGRESS_PROXY_API_TOKEN:
    process.env.INGRESS_PROXY_API_TOKEN?.trim() || process.env.CF_PROXY_WORKER_API_TOKEN?.trim(),
  TYPEID_PREFIX: process.env.TYPEID_PREFIX?.trim(),
  INGRESS_PROXY_ROUTE_PATTERN: process.env.INGRESS_PROXY_ROUTE_PATTERN?.trim(),
  INGRESS_PROXY_ROUTE_ZONE_ID: process.env.INGRESS_PROXY_ROUTE_ZONE_ID?.trim(),
});

const app = await alchemy("ingress-proxy", {
  stage: process.env.APP_STAGE ?? "ci",
  password: process.env.ALCHEMY_PASSWORD,
});

const db = await D1Database("db", {
  name: config.WORKER_NAME,
  migrationsDir: "./migrations",
  adopt: true,
});

const routes = config.INGRESS_PROXY_ROUTE_PATTERN
  ? [
      {
        pattern: config.INGRESS_PROXY_ROUTE_PATTERN,
        adopt: true,
        ...(config.INGRESS_PROXY_ROUTE_ZONE_ID
          ? { zoneId: config.INGRESS_PROXY_ROUTE_ZONE_ID }
          : {}),
      },
    ]
  : undefined;

export const worker = await Worker("worker", {
  name: config.WORKER_NAME,
  entrypoint: "./server.ts",
  compatibilityDate: "2025-02-24",
  compatibility: "node",
  bindings: {
    DB: db,
    INGRESS_PROXY_API_TOKEN: alchemy.secret(config.INGRESS_PROXY_API_TOKEN),
    TYPEID_PREFIX: config.TYPEID_PREFIX,
  },
  routes,
  adopt: true,
});

console.log(worker.url);

await app.finalize();
