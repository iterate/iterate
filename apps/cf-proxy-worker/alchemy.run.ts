import alchemy from "alchemy";
import { D1Database, Worker } from "alchemy/cloudflare";

const app = await alchemy("cf-proxy-worker", {
  password: process.env.ALCHEMY_PASSWORD,
});

const isProduction = app.stage === "prd";

const adminToken = process.env.CF_PROXY_WORKER_API_TOKEN?.trim();
if (!adminToken) {
  throw new Error("CF_PROXY_WORKER_API_TOKEN is required");
}

const db = await D1Database("routes-db", {
  name: isProduction ? "cf-proxy-worker-routes" : `cf-proxy-worker-routes-${app.stage}`,
  adopt: true,
});

export const worker = await Worker("worker", {
  name: isProduction ? "cf-proxy-worker" : undefined,
  entrypoint: "./server.ts",
  compatibilityDate: "2025-02-24",
  compatibility: "node",
  bindings: {
    DB: db,
    CF_PROXY_WORKER_API_TOKEN: alchemy.secret(adminToken),
  },
  routes: [{ pattern: "*.cf-ingress-worker.com/*", adopt: true }],
  adopt: true,
});

console.log(worker.url);

await app.finalize();
