import alchemy from "alchemy";
import { D1Database, Worker } from "alchemy/cloudflare";

const app = await alchemy("ingress-proxy", {
  password: process.env.ALCHEMY_PASSWORD,
});

const isProduction = app.stage === "prd";

const adminToken = process.env.INGRESS_PROXY_API_TOKEN?.trim();
if (!adminToken) {
  throw new Error("INGRESS_PROXY_API_TOKEN is required");
}

const db = await D1Database("routes-db", {
  name: isProduction ? "ingress-proxy-routes" : `ingress-proxy-routes-${app.stage}`,
  migrationsDir: "./migrations",
  adopt: true,
});

const routePattern = process.env.INGRESS_PROXY_ROUTE_PATTERN?.trim();
const routeZoneId = process.env.INGRESS_PROXY_ROUTE_ZONE_ID?.trim();
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
  name: isProduction ? "ingress-proxy" : undefined,
  entrypoint: "./server.ts",
  compatibilityDate: "2025-02-24",
  compatibility: "node",
  bindings: {
    DB: db,
    INGRESS_PROXY_API_TOKEN: alchemy.secret(adminToken),
    TYPEID_PREFIX: process.env.TYPEID_PREFIX?.trim() || "ipr",
  },
  routes,
  adopt: true,
});

console.log(worker.url);

await app.finalize();
