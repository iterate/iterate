/**
 * Agent Wrapper CLI
 *
 * Commands:
 *
 * start [--port] [--storage]               Start server + create Pi session
 * prompt <stream-name> <message>           Send prompt to agent
 * abort <stream-name>                      Abort current operation
 * subscribe <stream-name>                  Subscribe to stream events
 * list                                     List active agent sessions
 */
import { Args, Command, Options } from "@effect/cli";
import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import { Console, Effect, Layer, Schema, Stream } from "effect";
import { StreamClientService } from "../durable-streams/client.ts";
import { DaemonService } from "../durable-streams/daemon.ts";
import { Event, type StreamName } from "../durable-streams/types.ts";
import { AdapterRunnerService } from "./adapter-runner.ts";
import { type EventStreamId, makeAbortEvent, makePromptEvent } from "./types.ts";

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

const cwdOption = Options.text("cwd").pipe(
  Options.withDescription("Working directory for the agent"),
  Options.optional,
);

const sessionFileOption = Options.text("session-file").pipe(
  Options.withDescription("Specific session file to resume"),
  Options.optional,
);

// ─── Start Command ──────────────────────────────────────────────────────────

/** start - Start server and create Pi session */
const startCommand = Command.make(
  "start",
  { port: portOption, storage: storageOption, cwd: cwdOption, sessionFile: sessionFileOption },
  ({ cwd, port, sessionFile, storage }) =>
    Effect.gen(function* () {
      yield* Console.log(`Starting agent wrapper (port=${port}, storage=${storage})...`);

      // Start daemon if not running
      const daemon = yield* DaemonService;
      const status = yield* daemon.status();

      if (status._tag === "None") {
        yield* Console.log("Starting stream server daemon...");
        yield* daemon.start({ port, storage });
        yield* Console.log("Daemon started");
      } else {
        yield* Console.log(`Daemon already running (PID ${status.value})`);
      }

      // Start Pi session (uses Pi's default session dir: ~/.pi/agent/sessions/)
      const runner = yield* AdapterRunnerService;
      const sessionOptions: { cwd?: string; sessionFile?: string } = {};
      if (cwd._tag === "Some") sessionOptions.cwd = cwd.value;
      if (sessionFile._tag === "Some") sessionOptions.sessionFile = sessionFile.value;
      const result = yield* runner.startPiSession(
        Object.keys(sessionOptions).length > 0 ? sessionOptions : undefined,
      );

      yield* Console.log("");
      yield* Console.log("Pi session started!");
      yield* Console.log(`  Stream: ${result.streamName}`);
      yield* Console.log("");
      yield* Console.log("Listening for events... (Ctrl+C to stop)");
      yield* Console.log("");

      // Subscribe to stream and print events
      const client = yield* StreamClientService;
      const eventStream = yield* client.subscribe({ name: result.streamName });

      yield* eventStream.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const encoded = Schema.encodeSync(Event)(event);
            yield* Console.log(JSON.stringify(encoded, null, 2));
          }),
        ),
      );
    }).pipe(Effect.catchAll((e) => Console.error(`Error: ${e}`))),
).pipe(Command.withDescription("Start server and create a new Pi agent session"));

// ─── Prompt Command ─────────────────────────────────────────────────────────

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

      const event = makePromptEvent(streamName as unknown as EventStreamId, message);

      yield* client.append({
        name: streamName as StreamName,
        data: event,
      });

      yield* Console.log("Prompt sent!");
    }).pipe(Effect.catchAll((e) => Console.error(`Error: ${e}`))),
).pipe(Command.withDescription("Send prompt to agent"));

// ─── Abort Command ──────────────────────────────────────────────────────────

/** abort - Abort current operation */
const abortCommand = Command.make("abort", { streamName: streamNameArg }, ({ streamName }) =>
  Effect.gen(function* () {
    const client = yield* StreamClientService;

    yield* Console.log(`Sending abort to ${streamName}...`);

    const event = makeAbortEvent(streamName as unknown as EventStreamId);

    yield* client.append({
      name: streamName as StreamName,
      data: event,
    });

    yield* Console.log("Abort sent!");
  }).pipe(Effect.catchAll((e) => Console.error(`Error: ${e}`))),
).pipe(Command.withDescription("Abort current agent operation"));

// ─── Subscribe Command ──────────────────────────────────────────────────────

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

// ─── List Command ───────────────────────────────────────────────────────────

/** list - List active sessions */
const listCommand = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const runner = yield* AdapterRunnerService;
    const adapters = yield* runner.listAdapters();

    if (adapters.length === 0) {
      yield* Console.log("No active sessions");
    } else {
      yield* Console.log("Active sessions:");
      for (const adapter of adapters) {
        yield* Console.log(
          `  ${adapter.streamName} (${adapter.harness}) - created ${adapter.createdAt.toISOString()}`,
        );
      }
    }
  }).pipe(Effect.catchAll((e) => Console.error(`Error: ${e}`))),
).pipe(Command.withDescription("List active agent sessions"));

// ─── Root Command ───────────────────────────────────────────────────────────

const rootCommand = Command.make("agent-wrapper").pipe(
  Command.withSubcommands([
    startCommand,
    promptCommand,
    abortCommand,
    subscribeCommand,
    listCommand,
  ]),
  Command.withDescription("Agent wrapper for Pi coding agent"),
);

/** Main CLI definition */
export const cli = Command.run(rootCommand, {
  name: "agent-wrapper",
  version: "0.1.0",
});

/** Service layer for CLI */
export const cliLayer = Layer.mergeAll(
  DaemonService.Default,
  NodeContext.layer,
  NodeHttpClient.layer,
);

/** Run CLI with provided args */
export const run = (args: ReadonlyArray<string>) => cli(args);
