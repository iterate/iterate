/**
 * Iterate CLI
 *
 * Commands:
 *
 * server start [--port] [--storage]          Start daemonized server
 * server stop                                Stop daemon
 * server status                              Check daemon status
 *
 * prompt <stream-name> <message>             Send prompt to agent
 * abort <stream-name>                        Abort current operation
 * subscribe <stream-name>                    Subscribe to stream events
 * list                                       List all streams
 */
import { Args, Command, Options } from "@effect/cli";
import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import { Console, Effect, Layer, Option, Schema, Stream } from "effect";
import {
  StreamClientService,
  StreamClientLive,
  type StreamName,
  Event,
  OFFSET_START,
  type Offset,
} from "./client.ts";
import { DaemonService, DATA_DIR } from "./daemon.ts";

// ─── Pi Event Types (for prompt/abort commands) ─────────────────────────────
// These match the types in apps/daemon/agents/pi/types.ts

const PiEventTypes = {
  SESSION_CREATE: "pi:session-create",
  PROMPT: "pi:prompt",
  ABORT: "pi:abort",
  EVENT_RECEIVED: "pi:event-received",
} as const;

interface PiEvent {
  type: string;
  eventStreamId: string;
  createdAt: string;
  payload: unknown;
}

function makePromptEvent(eventStreamId: string, content: string): PiEvent {
  return {
    type: PiEventTypes.PROMPT,
    eventStreamId,
    createdAt: new Date().toISOString(),
    payload: { content },
  };
}

function makeAbortEvent(eventStreamId: string): PiEvent {
  return {
    type: PiEventTypes.ABORT,
    eventStreamId,
    createdAt: new Date().toISOString(),
    payload: {},
  };
}

// ─── Shared Options ─────────────────────────────────────────────────────────

const portOption = Options.integer("port").pipe(
  Options.withAlias("p"),
  Options.withDescription("Port for stream server"),
  Options.withDefault(3000),
);

const storageOption = Options.choice("storage", ["memory", "fs"]).pipe(
  Options.withDescription("Storage backend: memory (volatile) or fs (persistent)"),
  Options.withDefault("fs" as const),
);

const serverUrlOption = Options.text("server").pipe(
  Options.withAlias("s"),
  Options.withDescription("Server URL (overrides auto-daemon behavior)"),
  Options.optional,
);

// ─── Server Commands ────────────────────────────────────────────────────────

/** server start - start daemon */
const serverStartCommand = Command.make(
  "start",
  { port: portOption, storage: storageOption },
  ({ port, storage }) =>
    Effect.gen(function* () {
      const daemon = yield* DaemonService;
      const pid = yield* daemon.start({ port, storage });
      yield* Console.log(`Daemon started (PID ${pid}) on port ${port}`);
      yield* Console.log(`Storage: ${storage}`);
      yield* Console.log(`Logs: ${DATA_DIR}/daemon.log`);
    }).pipe(Effect.catchTag("DaemonError", (e) => Console.error(`Error: ${e.message}`))),
).pipe(Command.withDescription("Start daemonized server"));

/** server stop - stop daemon */
const serverStopCommand = Command.make("stop", {}, () =>
  Effect.gen(function* () {
    const daemon = yield* DaemonService;
    yield* daemon.stop();
    yield* Console.log("Daemon stopped");
  }).pipe(Effect.catchTag("DaemonError", (e) => Console.error(`Error: ${e.message}`))),
).pipe(Command.withDescription("Stop daemon"));

/** server status - check daemon status */
const serverStatusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const daemon = yield* DaemonService;
    const status = yield* daemon.status();
    if (Option.isSome(status)) {
      const url = yield* daemon.getServerUrl();
      yield* Console.log(`Running (PID ${status.value})`);
      if (Option.isSome(url)) {
        yield* Console.log(`URL: ${url.value}`);
      }
    } else {
      yield* Console.log("Not running");
    }
  }),
).pipe(Command.withDescription("Check daemon status"));

/** server command group */
const serverCommand = Command.make("server").pipe(
  Command.withSubcommands([serverStartCommand, serverStopCommand, serverStatusCommand]),
  Command.withDescription("Server management commands"),
);

// ─── Agent Commands ─────────────────────────────────────────────────────────

const streamNameArg = Args.text({ name: "stream-name" }).pipe(
  Args.withDescription("Name of the stream (e.g., pi-abc12345)"),
);

const messageArg = Args.text({ name: "message" }).pipe(
  Args.withDescription("Message to send to the agent"),
);

/** prompt - Send prompt to agent */
const promptCommand = Command.make(
  "prompt",
  { streamName: streamNameArg, message: messageArg },
  ({ message, streamName }) =>
    Effect.gen(function* () {
      const client = yield* StreamClientService;

      yield* Console.log(`Sending prompt to ${streamName}...`);

      const event = makePromptEvent(streamName, message);

      yield* client.append({
        name: streamName as StreamName,
        data: event,
      });

      yield* Console.log("Prompt sent!");
    }).pipe(Effect.catchAll((e) => Console.error(`Error: ${e}`))),
).pipe(Command.withDescription("Send prompt to agent"));

/** abort - Abort current operation */
const abortCommand = Command.make("abort", { streamName: streamNameArg }, ({ streamName }) =>
  Effect.gen(function* () {
    const client = yield* StreamClientService;

    yield* Console.log(`Sending abort to ${streamName}...`);

    const event = makeAbortEvent(streamName);

    yield* client.append({
      name: streamName as StreamName,
      data: event,
    });

    yield* Console.log("Abort sent!");
  }).pipe(Effect.catchAll((e) => Console.error(`Error: ${e}`))),
).pipe(Command.withDescription("Abort current agent operation"));

/** subscribe - Subscribe to stream events */
const subscribeCommand = Command.make(
  "subscribe",
  { streamName: streamNameArg },
  ({ streamName }) =>
    Effect.gen(function* () {
      const client = yield* StreamClientService;

      yield* Console.log(`Subscribing to ${streamName}...`);
      yield* Console.log("");

      const eventStream = yield* client.subscribe({ name: streamName as StreamName });

      yield* eventStream.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const encoded = Schema.encodeSync(Event)(event);
            yield* Console.log(JSON.stringify(encoded, null, 2));
          }),
        ),
      );
    }).pipe(Effect.catchAll((e) => Console.error(`Error: ${e}`))),
).pipe(Command.withDescription("Subscribe to stream events"));

/** list - List all streams */
const listCommand = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const client = yield* StreamClientService;
    const streams = yield* client.list();

    if (streams.length === 0) {
      yield* Console.log("No streams");
    } else {
      yield* Console.log("Streams:");
      for (const name of streams) {
        yield* Console.log(`  ${name}`);
      }
    }
  }).pipe(Effect.catchAll((e) => Console.error(`Error: ${e}`))),
).pipe(Command.withDescription("List all streams"));

// ─── Root Command ───────────────────────────────────────────────────────────

const rootCommand = Command.make("iterate").pipe(
  Command.withSubcommands([
    serverCommand,
    promptCommand,
    abortCommand,
    subscribeCommand,
    listCommand,
  ]),
  Command.withDescription("Iterate CLI - Agent management and stream operations"),
);

/** Main CLI definition */
export const cli = Command.run(rootCommand, {
  name: "iterate",
  version: "0.0.1",
});

/** Service layer for CLI - builds up dependencies in correct order */
const baseLayers = Layer.mergeAll(NodeContext.layer, NodeHttpClient.layer);
const daemonLayer = DaemonService.Live.pipe(Layer.provide(baseLayers));
const clientLayer = StreamClientLive.pipe(Layer.provide(daemonLayer), Layer.provide(baseLayers));

export const cliLayer = Layer.mergeAll(baseLayers, daemonLayer, clientLayer);

/** Run CLI with provided args */
export const run = (args: ReadonlyArray<string>) => cli(args);
