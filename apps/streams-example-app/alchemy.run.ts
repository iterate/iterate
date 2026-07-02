import { DurableObjectNamespace } from "alchemy/cloudflare";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import { IterateApp } from "@iterate-com/shared/alchemy/iterate-app";
import { AppConfig } from "./src/config.ts";
import type { StreamDurableObject } from "~/domains/streams/stream-durable-object.ts";

const ctx = await initAlchemy("streams-example-app", AppConfig, process.env);

// The next-engine StreamDurableObject's `Env` type declares the full next
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

const worker = await IterateApp(ctx, {
  main: "./src/worker.ts",
  bindings: {
    STREAM: stream,
  },
});

export { worker };

await ctx.app.finalize();

if (!ctx.app.local) process.exit(0);
