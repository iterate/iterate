import { D1Database, DurableObjectNamespace, Worker } from "alchemy/cloudflare";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import { IterateApp } from "@iterate-com/shared/alchemy/iterate-app";
import manifest, { AppConfig } from "./src/app.ts";
import type { ExampleCounter } from "./src/durable-objects/example-counter.ts";

const ctx = await initAlchemy(manifest, AppConfig, process.env);

const db = await D1Database("example-db", {
  name: `${ctx.workerName}-db`,
  migrationsDir: "./drizzle",
  adopt: true,
});

const exampleCounterWorker = await Worker("example-counter-do", {
  name: `${ctx.workerName}-example-counter-do`,
  entrypoint: "./src/durable-objects/example-counter.ts",
  adopt: true,
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    EXAMPLE_COUNTER: DurableObjectNamespace<ExampleCounter>("example-counter", {
      className: "ExampleCounter",
      sqlite: true,
    }),
  },
});

const { worker, afterFinalize } = await IterateApp(ctx, {
  bindings: {
    DB: db,
    EXAMPLE_COUNTER: exampleCounterWorker.bindings.EXAMPLE_COUNTER,
  },
  build: "pnpm exec vite build --config vite.cf.config.ts",
  dev: { command: "pnpm exec vite dev --config vite.cf.config.ts" },
});

export { worker };

await ctx.app.finalize();
await afterFinalize();

if (!ctx.app.local) process.exit(0);
