import { D1Database } from "alchemy/cloudflare";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import { IterateApp } from "@iterate-com/shared/alchemy/iterate-app";
import manifest, { AppConfig } from "./src/app.ts";

const ctx = await initAlchemy(manifest, AppConfig, process.env);

const db = await D1Database("ingress-proxy-routes", {
  name: `${ctx.workerName}-routes`,
  migrationsDir: "./sql/migrations",
  adopt: true,
});

const { worker, afterFinalize } = await IterateApp(ctx, {
  bindings: { DB: db },
  build: "pnpm exec vite build",
  dev: { command: "pnpm exec vite dev" },
  extraRouteHostnames: parseWorkerRoutes(process.env.WORKER_ROUTES),
});

export { worker };

await ctx.app.finalize();
await afterFinalize();

if (!ctx.app.local) process.exit(0);

function parseWorkerRoutes(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .map((entry) => entry.replace(/\/\*$/, ""))
    .filter(Boolean)
    .map((hostname) => {
      if (hostname.includes("/") || hostname.includes("://")) {
        throw new Error("WORKER_ROUTES entries must be hostnames without scheme or path");
      }
      return hostname;
    });
}
