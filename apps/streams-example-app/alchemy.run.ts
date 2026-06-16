import { DurableObjectNamespace } from "alchemy/cloudflare";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import { IterateApp } from "@iterate-com/shared/alchemy/iterate-app";
import { AppConfig } from "./src/config.ts";
import type { Stream } from "~/domains/streams/engine/workers/durable-objects/stream.ts";
import type { StreamProcessorRunner } from "~/domains/streams/engine/workers/test-support/stream-processor-runner.ts";

const ctx = await initAlchemy("streams-example-app", AppConfig, process.env);

const stream = DurableObjectNamespace<Stream>("stream", {
  className: "Stream",
  sqlite: true,
});

const streamProcessorRunner = DurableObjectNamespace<StreamProcessorRunner>(
  "stream-processor-runner",
  {
    className: "StreamProcessorRunner",
    sqlite: true,
  },
);

const { worker, afterFinalize } = await IterateApp(ctx, {
  main: "./src/worker.ts",
  bindings: {
    STREAM: stream,
    STREAM_PROCESSOR_RUNNER: streamProcessorRunner,
  },
});

export { worker };

await ctx.app.finalize();
await afterFinalize();

if (!ctx.app.local) process.exit(0);
