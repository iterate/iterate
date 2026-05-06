import { D1Database, DurableObjectNamespace } from "alchemy/cloudflare";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import { IterateApp } from "@iterate-com/shared/alchemy/iterate-app";
import { z } from "zod";
import manifest, { AppConfig } from "./src/app.ts";
import type { E2EAppendChainSubscriber } from "~/entry.workerd.ts";
import type { StreamDurableObject } from "~/entry.workerd.ts";

const DeploymentConfig = z.object({
  streamDurableObjectBindingScriptName: z.string().trim().min(1).optional(),
});

const ctx = await initAlchemy(manifest, AppConfig, process.env);
const deploymentConfig = parseAppConfigFromEnv({
  configSchema: DeploymentConfig,
  prefix: "DEPLOYMENT_CONFIG_",
  env: process.env,
});

const db = await D1Database("events-db", {
  name: `${ctx.workerName}-db`,
  migrationsDir: "./src/db/migrations",
  adopt: true,
});

const stream =
  deploymentConfig.streamDurableObjectBindingScriptName == null
    ? DurableObjectNamespace<StreamDurableObject>("stream", {
        className: "StreamDurableObject",
        sqlite: true,
      })
    : DurableObjectNamespace<StreamDurableObject>("stream", {
        // Deployed Events should use OS2's Stream Durable Object script so all
        // stream state and callable subscription delivery share one deployment
        // boundary. The Events app remains a UI/oRPC debugging surface; shared
        // stream schemas and the DO implementation live in `packages/shared`.
        className: "StreamDurableObject",
        scriptName: deploymentConfig.streamDurableObjectBindingScriptName,
      });
const e2eAppendChainSubscriber = DurableObjectNamespace<E2EAppendChainSubscriber>(
  "e2e-append-chain-subscriber",
  {
    className: "E2EAppendChainSubscriber",
    sqlite: true,
  },
);

const { worker, afterFinalize } = await IterateApp(ctx, {
  bindings: {
    DB: db,
    DO_CATALOG: db,
    E2E_APPEND_CHAIN_SUBSCRIBER: e2eAppendChainSubscriber,
    STREAM: stream,
  },
  // Cloudflare gates `request.signal` behind this flag — needed by the oRPC
  // logging plugin to distinguish aborted client requests from real failures.
  // https://developers.cloudflare.com/workers/runtime-apis/request/
  // `global_fetch_strictly_public` lets this Worker call same-zone Worker routes
  // such as agents.iterate.com via fetch instead of bypassing Workers to origin.
  compatibilityFlags: ["enable_request_signal", "global_fetch_strictly_public"],
  extraRouteHostnames: projectRouteHostnamesForBaseUrl(ctx.runtimeConfig.baseUrl),
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
