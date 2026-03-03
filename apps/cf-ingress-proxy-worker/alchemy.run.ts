import alchemy from "alchemy";
import { D1Database, Worker } from "alchemy/cloudflare";
import { z } from "zod/v4";
import { TypeIdPrefixSchema } from "./typeid-prefix.ts";

const Env = z.object({
  ALCHEMY_PASSWORD: z.string().optional(),
  WORKER_NAME: z.string().trim().min(1, "WORKER_NAME is required"),
  INGRESS_PROXY_API_TOKEN: z.string().trim().min(1, "INGRESS_PROXY_API_TOKEN is required"),
  TYPEID_PREFIX: TypeIdPrefixSchema,
  INGRESS_PROXY_ROUTE_PATTERN: z.string().trim().optional(),
  INGRESS_PROXY_ROUTE_PATTERNS: z.string().trim().optional(),
  INGRESS_PROXY_ROUTE_ZONE_ID: z.string().trim().optional(),
});

const env = Env.parse(process.env);
const adminToken = env.INGRESS_PROXY_API_TOKEN;

const app = await alchemy("ingress-proxy", {
  password: env.ALCHEMY_PASSWORD,
});

const db = await D1Database("routes-db", {
  name: `${env.WORKER_NAME}-routes`,
  migrationsDir: "./migrations",
  adopt: true,
});

const routePatternConfig = env.INGRESS_PROXY_ROUTE_PATTERNS ?? env.INGRESS_PROXY_ROUTE_PATTERN;
const routeZoneId = env.INGRESS_PROXY_ROUTE_ZONE_ID;
const routePatterns = (() => {
  const defaultPatterns = ["ingress.iterate.com/*", "*.ingress.iterate.com/*"];
  const configuredPatterns = routePatternConfig
    ? routePatternConfig
        .split(",")
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern.length > 0)
    : [];
  return [...new Set(configuredPatterns.length > 0 ? configuredPatterns : defaultPatterns)];
})();
const routes = routePatterns.map((pattern) => ({
  pattern,
  adopt: true,
  ...(routeZoneId ? { zoneId: routeZoneId } : {}),
}));

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

console.log(worker.url);

await app.finalize();
