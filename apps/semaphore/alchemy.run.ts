import { D1Database, DurableObjectNamespace } from "alchemy/cloudflare";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import {
  IterateAppWorker,
  IterateRoutes,
  deriveWorkerRouteHosts,
} from "@iterate-com/shared/alchemy/iterate-app";
import { AppConfig } from "./src/config.ts";
import type { ResourceCoordinator } from "~/durable-objects/resource-coordinator.ts";

const ctx = await initAlchemy("semaphore", AppConfig, process.env);

const db = await D1Database("resources-db", {
  name: `${ctx.workerName}-resources`,
  migrationsDir: "./migrations",
  adopt: true,
});

const coordinator = DurableObjectNamespace<ResourceCoordinator>("resource-coordinator", {
  className: "ResourceCoordinator",
  sqlite: true,
});

const worker = await IterateAppWorker(ctx, {
  main: "./src/worker.ts",
  bindings: { DB: db, RESOURCE_COORDINATOR: coordinator },
});

console.dir({ url: ctx.runtimeConfig.baseUrl ?? worker.url, workersDevUrl: worker.url });

export { worker };

await ctx.app.finalize();

// Routes are ensured after finalize — they are not alchemy resources (see
// iterate-app.ts for the lifecycle rationale).
await IterateRoutes(ctx, {
  worker,
  hostnames: deriveWorkerRouteHosts(ctx.runtimeConfig.baseUrl),
});

if (!ctx.app.local) process.exit(0);
