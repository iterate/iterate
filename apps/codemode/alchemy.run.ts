import { D1Database, Worker, WorkerLoader } from "alchemy/cloudflare";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import { IterateApp } from "@iterate-com/shared/alchemy/iterate-app";
import manifest, { AppConfig } from "./src/app.ts";

const ctx = await initAlchemy(manifest, AppConfig, process.env);

const db = await D1Database("codemode-db", {
  name: `${ctx.workerName}-db`,
  migrationsDir: "./drizzle",
  adopt: true,
});

// Outbound worker has `global_fetch_strictly_public` to prevent SSRF from
// user-submitted code snippets. It runs in a separate isolate with restricted fetch.
const outboundWorker = await Worker("codemode-outbound", {
  name: `${ctx.workerName}-outbound`,
  adopt: true,
  compatibilityFlags: ["global_fetch_strictly_public"],
  bindings: { DB: db },
  entrypoint: "./src/outbound-worker.ts",
});

const { worker, afterFinalize } = await IterateApp(ctx, {
  bindings: {
    DB: db,
    LOADER: WorkerLoader(),
    OUTBOUND: outboundWorker,
  },
  compatibilityFlags: ["global_fetch_strictly_public"],
  build: "pnpm exec vite build --config vite.cf.config.ts",
  dev: { command: "pnpm exec vite dev --config vite.cf.config.ts" },
});

export { worker };

await ctx.app.finalize();
await afterFinalize();

if (!ctx.app.local) process.exit(0);
