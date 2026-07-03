import { DurableObjectNamespace } from "alchemy/cloudflare";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import {
  IterateAppWorker,
  IterateRoutes,
  deriveWorkerRouteHosts,
} from "@iterate-com/shared/alchemy/iterate-app";
import { AppConfig } from "./src/config.ts";
import type { StreamDurableObject } from "~/domains/streams/stream-durable-object.ts";

const ctx = await initAlchemy("streams-example-app", AppConfig, process.env);

// The itx StreamDurableObject's `Env` type declares the full next
// binding set (AGENT/ITX/PROJECT/REPO/SECRET/WORKER/AI/ARTIFACTS/LOADER/...),
// but this standalone playground only exercises the stream surface. At runtime
// the class touches `env.STREAM` alone (appends, ancestor announcements,
// cross-posts); the other namespaces are dialed only when a CONFIGURED
// durable-object/worker subscriber wakes, which this app never configures.
// So we deliberately bind only STREAM — to the app's own re-exported class —
// and leave the rest unbound instead of stamping out stub DO classes.
const stream = DurableObjectNamespace<StreamDurableObject>("stream", {
  className: "StreamDurableObject",
  sqlite: true,
});

const worker = await IterateAppWorker(ctx, {
  main: "./src/worker.ts",
  bindings: {
    STREAM: stream,
  },
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
