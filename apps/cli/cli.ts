/**
 * Iterate CLI
 *
 * Commands:
 *
 * server start [--port]    Start daemonized server
 * server stop              Stop daemon
 * server status            Check daemon status
 */
import { Command, Options } from "@effect/cli";
import { NodeContext } from "@effect/platform-node";
import { Console, Effect, Layer, Option } from "effect";
import { DaemonService, DATA_DIR } from "./daemon.ts";

// ─── Shared Options ─────────────────────────────────────────────────────────

const portOption = Options.integer("port").pipe(
  Options.withAlias("p"),
  Options.withDescription("Port for daemon server"),
  Options.withDefault(3000),
);

// ─── Server Commands ────────────────────────────────────────────────────────

/** server start - start daemon */
const serverStartCommand = Command.make("start", { port: portOption }, ({ port }) =>
  Effect.gen(function* () {
    const daemon = yield* DaemonService;
    const pid = yield* daemon.start({ port });
    yield* Console.log(`Daemon started (PID ${pid}) on port ${port}`);
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

// ─── Root Command ───────────────────────────────────────────────────────────

const rootCommand = Command.make("iterate").pipe(
  Command.withSubcommands([serverCommand]),
  Command.withDescription("Iterate CLI - Daemon management"),
);

/** Main CLI definition */
export const cli = Command.run(rootCommand, {
  name: "iterate",
  version: "0.0.1",
});

/** Service layer for CLI */
export const cliLayer = Layer.mergeAll(
  NodeContext.layer,
  DaemonService.Live.pipe(Layer.provide(NodeContext.layer)),
);

/** Run CLI with provided args */
export const run = (args: ReadonlyArray<string>) => cli(args);
