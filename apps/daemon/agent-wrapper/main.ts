/**
 * Agent Wrapper CLI Entry Point
 *
 * Usage:
 *   npx tsx src/agent-wrapper/main.ts start [--port 3000]
 *   npx tsx src/agent-wrapper/main.ts prompt <stream-name> "message"
 *   npx tsx src/agent-wrapper/main.ts subscribe <stream-name>
 *   npx tsx src/agent-wrapper/main.ts list
 */
import { NodeContext, NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Cause, Effect, Layer, Logger, LogLevel } from "effect";
import { StreamClientLive } from "../durable-streams/client.ts";
import { DaemonService } from "../durable-streams/daemon.ts";
import { AdapterRunnerService } from "./adapter-runner.ts";
import { run } from "./cli.ts";

const loggingLayer = Logger.minimumLogLevel(LogLevel.Info);

// Build the layer stack
// DaemonService needs FileSystem + Path (from NodeContext)
// StreamClientLive needs HttpClient + DaemonService
// AdapterRunnerService needs StreamClientService
const baseLayer = StreamClientLive.pipe(
  Layer.provideMerge(DaemonService.Live),
  Layer.provideMerge(NodeHttpClient.layer),
  Layer.provideMerge(NodeContext.layer),
);

const servicesLayer = Layer.provideMerge(AdapterRunnerService.Default, baseLayer);

const mainLayer = Layer.mergeAll(loggingLayer, servicesLayer);

run(process.argv).pipe(
  Effect.provide(mainLayer),
  Effect.catchAllCause((cause) =>
    Cause.isInterruptedOnly(cause) ? Effect.void : Effect.failCause(cause),
  ),
  NodeRuntime.runMain,
);
