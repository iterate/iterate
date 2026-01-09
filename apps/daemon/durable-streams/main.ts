/**
 * Durable Streams CLI Entry Point
 *
 * Usage:
 *   npx tsx src/durable-streams/main.ts server run [--port 3000]
 *   npx tsx src/durable-streams/main.ts server start [--port 3000]
 *   npx tsx src/durable-streams/main.ts server stop
 *   npx tsx src/durable-streams/main.ts server status
 *   npx tsx src/durable-streams/main.ts stream subscribe <name>
 *   npx tsx src/durable-streams/main.ts stream append <name> -m "hello"
 */
import { NodeContext, NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { Cause, Effect, Layer, Logger, LogLevel } from "effect"
import { run } from "./cli.ts"
import { StreamClientLive } from "./client.ts"
import { DaemonService } from "./daemon.ts"

const loggingLayer = Logger.minimumLogLevel(LogLevel.Info)

// Build the layer stack with proper dependencies
// DaemonService.Live needs FileSystem + Path (from NodeContext)
// StreamClientLive needs HttpClient + DaemonService
const servicesLayer = StreamClientLive.pipe(
  Layer.provideMerge(DaemonService.Live),
  Layer.provideMerge(NodeHttpClient.layer),
  Layer.provideMerge(NodeContext.layer)
)

const mainLayer = Layer.mergeAll(loggingLayer, servicesLayer)

run(process.argv).pipe(
  Effect.provide(mainLayer),
  Effect.catchAllCause((cause) => Cause.isInterruptedOnly(cause) ? Effect.void : Effect.failCause(cause)),
  NodeRuntime.runMain
)
