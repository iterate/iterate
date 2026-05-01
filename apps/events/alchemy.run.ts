import { D1Database, DurableObjectNamespace } from "alchemy/cloudflare";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import { IterateApp } from "@iterate-com/shared/alchemy/iterate-app";
import manifest, { AppConfig } from "./src/app.ts";
import type { StreamDurableObject } from "~/entry.workerd.ts";

const ctx = await initAlchemy(manifest, AppConfig, process.env);

const db = await D1Database("events-db", {
  name: `${ctx.workerName}-db`,
  migrationsDir: "./src/db/migrations",
  adopt: true,
});

const stream = DurableObjectNamespace<StreamDurableObject>("stream", {
  className: "StreamDurableObject",
  sqlite: true,
});

const { worker, afterFinalize } = await IterateApp(ctx, {
  bindings: {
    DB: db,
    STREAM: stream,
  },
  // Cloudflare gates `request.signal` behind this flag — needed by the oRPC
  // logging plugin to distinguish aborted client requests from real failures.
  // https://developers.cloudflare.com/workers/runtime-apis/request/
  // `global_fetch_strictly_public` lets this Worker call same-zone Worker routes
  // such as agents.iterate.com via fetch instead of bypassing Workers to origin.
  compatibilityFlags: ["enable_request_signal", "global_fetch_strictly_public"],
  extraRouteHostnames: projectRouteHostnamesForBaseUrl(ctx.compiledAppConfig.baseUrl),
});

export { worker };

await ctx.app.finalize();
await afterFinalize();

if (!ctx.app.local) process.exit(0);

function projectRouteHostnamesForBaseUrl(baseUrl: string | undefined) {
  if (!baseUrl) return [];

  const hostname = new URL(baseUrl).hostname;
  if (hostname === "localhost" || hostname.endsWith(".workers.dev")) return [];

  return [`*.${hostname}`];
}
