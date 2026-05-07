import { D1Database, DurableObjectNamespace } from "alchemy/cloudflare";
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

const { worker, afterFinalize } = await IterateApp(ctx, {
  bindings: {
    DB: db,
    EXAMPLE_COUNTER: DurableObjectNamespace<ExampleCounter>("example-counter-app", {
      className: "ExampleCounter",
      sqlite: true,
    }),
  },
  build: "pnpm exec vite build --config vite.cf.config.ts",
  dev: { command: "pnpm exec vite dev --config vite.cf.config.ts" },
});

export { worker };

await ctx.app.finalize();
await afterFinalize();

if (!ctx.app.local) process.exit(0);
