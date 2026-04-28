import { Ai, DurableObjectNamespace, Self, Worker, WorkerLoader } from "alchemy/cloudflare";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import { IterateApp } from "@iterate-com/shared/alchemy/iterate-app";
import manifest, { AppConfig } from "./src/app.ts";
import type { IterateAgent } from "./src/durable-objects/iterate-agent.ts";

const ctx = await initAlchemy(manifest, AppConfig, process.env);

const iterateAgent = DurableObjectNamespace<IterateAgent>("iterate-agent", {
  className: "IterateAgent",
  sqlite: true,
});

const { worker, afterFinalize } = await IterateApp(ctx, {
  bindings: {
    ITERATE_AGENT: iterateAgent,
    LOADER: WorkerLoader(),
    AI: Ai(),
    // Nested codemode workers need a real `Fetcher` for `globalOutbound`,
    // not `globalThis.fetch`. Same pattern as events' DynamicWorkerEgressGateway.
    CODEMODE_OUTBOUND_FETCH: Worker.experimentalEntrypoint(Self, "CodemodeOutboundFetch"),
  },
  // Cloudflare gates `request.signal` behind this flag — needed by the oRPC
  // logging plugin to distinguish aborted client requests from real failures.
  // https://developers.cloudflare.com/workers/runtime-apis/request/
  compatibilityFlags: ["enable_request_signal"],
});

export { worker };

await ctx.app.finalize();
await afterFinalize();

if (!ctx.app.local) process.exit(0);
