import { D1Database, DurableObjectNamespace } from "alchemy/cloudflare";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import { IterateApp } from "@iterate-com/shared/alchemy/iterate-app";
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

const { worker, afterFinalize } = await IterateApp(ctx, {
  main: "./src/worker.ts",
  bindings: { DB: db, RESOURCE_COORDINATOR: coordinator },
});

export { worker };

await ctx.app.finalize();
await afterFinalize();

if (!ctx.app.local) process.exit(0);
