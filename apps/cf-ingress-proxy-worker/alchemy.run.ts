import alchemy from "alchemy";
import { D1Database, Worker, WranglerJson } from "alchemy/cloudflare";
import { z } from "zod/v4";
import { TypeIdPrefixSchema } from "./typeid-prefix.ts";

const Env = z.object({
  ALCHEMY_PASSWORD: z.string().optional(),
  WORKER_NAME: z.string().trim().min(1, "WORKER_NAME is required"),
  INGRESS_PROXY_API_TOKEN: z.string().trim().min(1).optional(),
  CF_PROXY_WORKER_API_TOKEN: z.string().trim().min(1).optional(),
  TYPEID_PREFIX: TypeIdPrefixSchema,
  INGRESS_PROXY_ROUTE_PATTERN: z.string().trim().optional(),
  INGRESS_PROXY_ROUTE_ZONE_ID: z.string().trim().optional(),
});

const env = Env.parse(process.env);
const adminToken = env.INGRESS_PROXY_API_TOKEN ?? env.CF_PROXY_WORKER_API_TOKEN;
if (!adminToken) {
  throw new Error("INGRESS_PROXY_API_TOKEN or CF_PROXY_WORKER_API_TOKEN is required");
}

const app = await alchemy("ingress-proxy", {
  password: env.ALCHEMY_PASSWORD,
});

const db = await D1Database("routes-db", {
  name: `${env.WORKER_NAME}-routes`,
  migrationsDir: "./migrations",
  adopt: true,
});

const routePattern = env.INGRESS_PROXY_ROUTE_PATTERN;
const routeZoneId = env.INGRESS_PROXY_ROUTE_ZONE_ID;
const routes = routePattern
  ? [
      {
        pattern: routePattern,
        adopt: true,
        ...(routeZoneId ? { zoneId: routeZoneId } : {}),
      },
    ]
  : undefined;

export const worker = await Worker("worker", {
  name: env.WORKER_NAME,
  entrypoint: "./server.ts",
  compatibilityDate: "2025-02-24",
  compatibility: "node",
  bindings: {
    DB: db,
    INGRESS_PROXY_API_TOKEN: alchemy.secret(adminToken),
    TYPEID_PREFIX: env.TYPEID_PREFIX,
  },
  routes,
  adopt: true,
});

await WranglerJson({
  worker,
  path: "./wrangler.jsonc",
  secrets: false,
  transform: {
    wrangler: (spec) => ({
      ...spec,
      vars: {
        ...(spec.vars ?? {}),
        INGRESS_PROXY_API_TOKEN: "test-token",
        TYPEID_PREFIX: "tst",
      },
    }),
  },
});

console.log(worker.url);

await app.finalize();
