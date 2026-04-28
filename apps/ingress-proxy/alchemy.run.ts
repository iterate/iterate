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
});

export { worker };

await ctx.app.finalize();
await afterFinalize();

if (!ctx.app.local) process.exit(0);
