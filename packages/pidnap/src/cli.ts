#!/usr/bin/env node
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { format } from "node:util";
import { RPCHandler } from "@orpc/server/node";
import { onError } from "@orpc/server";
import * as v from "valibot";
import Table from "cli-table3";
import { os as osBase } from "@orpc/server";
import { createCli, type TrpcCliMeta } from "trpc-cli";
import pkg from "../package.json" assert { type: "json" };
import { router } from "./api/server.ts";
import { Manager, ManagerConfig } from "./manager.ts";
import { logger } from "./logger.ts";
import { createClient, type Client } from "./api/client.ts";
import { ProcessDefinition } from "./lazy-process.ts";
import { tImport } from "./utils.ts";

const os = osBase.$context<{ client: Client }>().$meta<TrpcCliMeta>({});

const ResourceTarget = v.union([v.string(), v.number()]);

const makeTable = (head?: string[]) => new Table({ head });

// Helper functions for table formatting (used multiple times)
function printProcessTable(proc: { name: string; state: string; restarts: number }) {
  const table = makeTable(["Name", "State", "Restarts"]);
  table.push([proc.name, proc.state, proc.restarts]);
  console.log(table.toString());
}

function printProcessDetails(
  proc: {
    name: string;
    state: string;
    restarts: number;
    definition: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    };
    effectiveEnv?: Record<string, string>;
  },
  options?: { showEffectiveEnv?: boolean },
) {
  const table = makeTable(["Name", "State", "Restarts"]);
  table.push([proc.name, proc.state, proc.restarts]);
  console.log(table.toString());

  console.log("\nDefinition:");
  const defTable = makeTable();
  defTable.push(
    { Command: proc.definition.command },
    { Args: proc.definition.args?.join(" ") ?? "(none)" },
    { Cwd: proc.definition.cwd ?? "(default)" },
  );
  console.log(defTable.toString());

  if (options?.showEffectiveEnv && proc.effectiveEnv) {
    console.log("\nEffective Environment (inherited by process):");
    const envTable = makeTable(["Variable", "Value"]);
    const sortedKeys = Object.keys(proc.effectiveEnv).sort();
    for (const key of sortedKeys) {
      envTable.push([key, proc.effectiveEnv[key]]);
    }
    console.log(envTable.toString());
  } else if (proc.definition.env && Object.keys(proc.definition.env).length > 0) {
    console.log("\nDefinition Environment Variables:");
    const envTable = makeTable(["Variable", "Value"]);
    for (const [key, value] of Object.entries(proc.definition.env)) {
      envTable.push([key, value]);
    }
    console.log(envTable.toString());
  }
}

function printTaskTable(task: { id: string; state: string; processNames: string[] }) {
  const table = makeTable(["Id", "State", "Processes"]);
  table.push([task.id, task.state, task.processNames.join(", ")]);
  console.log(table.toString());
}

type ProcessDefinitionType = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

function printDefinition(definition: ProcessDefinitionType, indent = "") {
  const defTable = makeTable();
  defTable.push(
    { Command: definition.command },
    { Args: definition.args?.join(" ") ?? "(none)" },
    { Cwd: definition.cwd ?? "(default)" },
  );
  console.log(defTable.toString());

  if (definition.env && Object.keys(definition.env).length > 0) {
    console.log(`${indent}\nEnvironment Variables:`);
    const envTable = makeTable(["Variable", "Value"]);
    for (const [key, value] of Object.entries(definition.env)) {
      envTable.push([key, value]);
    }
    console.log(envTable.toString());
  }
}

function printTaskDetails(
  task: {
    id: string;
    state: string;
    processNames: string[];
    processes: {
      name: string;
      definition: ProcessDefinitionType;
      effectiveEnv?: Record<string, string>;
    }[];
  },
  options?: { showEffectiveEnv?: boolean },
) {
  const table = makeTable(["Id", "State", "Processes"]);
  table.push([task.id, task.state, task.processNames.join(", ")]);
  console.log(table.toString());

  for (const proc of task.processes) {
    console.log(`\nProcess: ${proc.name}`);
    printDefinition(proc.definition);

    if (options?.showEffectiveEnv && proc.effectiveEnv) {
      console.log("\nEffective Environment (inherited by process):");
      const envTable = makeTable(["Variable", "Value"]);
      const sortedKeys = Object.keys(proc.effectiveEnv).sort();
      for (const key of sortedKeys) {
        envTable.push([key, proc.effectiveEnv[key]]);
      }
      console.log(envTable.toString());
    }
  }
}

function printCronTable(cron: {
  name: string;
  state: string;
  runCount: number;
  failCount: number;
  nextRun: string | null;
}) {
  const table = makeTable(["Name", "State", "Runs", "Fails", "Next Run"]);
  table.push([cron.name, cron.state, cron.runCount, cron.failCount, cron.nextRun ?? "-"]);
  console.log(table.toString());
}

function printCronDetails(
  cron: {
    name: string;
    state: string;
    runCount: number;
    failCount: number;
    nextRun: string | null;
    definition: ProcessDefinitionType;
    effectiveEnv?: Record<string, string>;
  },
  options?: { showEffectiveEnv?: boolean },
) {
  const table = new Table({ head: ["Name", "State", "Runs", "Fails", "Next Run"], wordWrap: true });
  table.push([cron.name, cron.state, cron.runCount, cron.failCount, cron.nextRun ?? "-"]);
  console.log(table.toString());

  console.log("\nDefinition:");
  printDefinition(cron.definition);

  if (options?.showEffectiveEnv && cron.effectiveEnv) {
    console.log("\nEffective Environment (inherited by process):");
    const envTable = new Table({ head: ["Variable", "Value"], wordWrap: true });
    const sortedKeys = Object.keys(cron.effectiveEnv).sort();
    for (const key of sortedKeys) {
      envTable.push([key, cron.effectiveEnv[key]]);
    }
    console.log(envTable.toString());
  }
}

const cliRouter = os.router({
  init: osBase
    .meta({
      description: "Initialize and run the process manager with config file",
      aliases: { options: { config: "c" } },
    })
    .input(
      v.object({
        config: v.optional(
          v.pipe(v.string(), v.description("Path to config file")),
          "pidnap.config.ts",
        ),
      }),
    )
    .handler(async ({ input }) => {
      process.title = "pidnap";
      const initLogger = logger({ name: "pidnap" });
      try {
        // Resolve config file path
        const configPath = resolve(process.cwd(), input.config);
        const configUrl = pathToFileURL(configPath).href;

        // Import the config file
        const configModule = await tImport(configUrl);
        const rawConfig =
          configModule.default.default || configModule.default || configModule.config || {};

        // Parse and validate the config with Valibot
        const config = v.parse(ManagerConfig, rawConfig);

        // Extract HTTP config with defaults
        const host = config.http?.host ?? "127.0.0.1";
        const port = config.http?.port ?? 9876;
        const authToken = config.http?.authToken;

        // Create manager with config
        const logDir = config.logDir ?? resolve(process.cwd(), "logs");
        const managerLogger = logger({ name: "pidnap", logFile: resolve(logDir, "pidnap.log") });
        const manager = new Manager(config, managerLogger);

        // Setup ORPC server with optional auth token middleware
        const handler = new RPCHandler(router, {
          interceptors: [
            onError((error) => {
              managerLogger.error(error);
            }),
          ],
        });

        const server = createServer(async (req, res) => {
          // Check auth token if configured
          if (authToken) {
            const providedToken = req.headers["authorization"]?.replace("Bearer ", "");
            if (providedToken !== authToken) {
              res.statusCode = 401;
              res.end("Unauthorized");
              return;
            }
          }

          const { matched } = await handler.handle(req, res, {
            prefix: "/rpc",
            context: { manager },
          });
          if (matched) return;
          res.statusCode = 404;
          res.end("Not found\n");
        });

        server.listen(port, host, async () => {
          managerLogger.info(`pidnap RPC server running on http://${host}:${port}`);
          if (authToken) {
            managerLogger.info("Auth token required for API access");
          }

          try {
            await manager.start();
          } catch (err) {
            managerLogger.error("Failed to start manager:", err);
            server.close();
            process.exit(1);
          }
        });

        // Wait for shutdown
        await manager.waitForShutdown();

        // Close server on shutdown
        server.close();
      } catch (error) {
        initLogger.error("Failed to start pidnap:", error);
        process.exit(1);
      }
    }),

  status: os
    .meta({ description: "Show manager status" })
    .handler(async ({ context: { client } }) => {
      const status = await client.manager.status();
      const table = new Table({ head: ["State", "Processes", "Crons", "Tasks"], wordWrap: true });
      table.push([status.state, status.processCount, status.cronCount, status.taskCount]);
      console.log(table.toString());
    }),

  process: os.router({
    list: os
      .meta({ description: "List restarting processes" })
      .handler(async ({ context: { client } }) => {
        const processes = await client.processes.list();
        const table = new Table({ head: ["Name", "State", "Restarts"], wordWrap: true });
        for (const proc of processes) {
          table.push([proc.name, proc.state, proc.restarts]);
        }
        console.log(table.toString());
      }),
    get: os
      .meta({
        description: "Get a restarting process by name or index",
        aliases: { options: { env: "e" } },
      })
      .input(
        v.tuple([
          v.pipe(ResourceTarget, v.description("Process name or index")),
          v.object({
            env: v.optional(
              v.pipe(v.boolean(), v.description("Show effective environment inherited by process")),
            ),
          }),
        ]),
      )
      .handler(async ({ input, context: { client } }) => {
        const [target, options] = input;
        const proc = await client.processes.get({
          target,
          includeEffectiveEnv: options.env,
        });
        printProcessDetails(proc, { showEffectiveEnv: options.env });
      }),
    add: os
      .meta({
        description: "Add a restarting process",
        aliases: { options: { name: "n", definition: "d" } },
      })
      .input(
        v.object({
          name: v.pipe(v.string(), v.description("Process name")),
          definition: v.pipe(ProcessDefinition, v.description("Process definition JSON")),
        }),
      )
      .handler(async ({ input, context: { client } }) => {
        const proc = await client.processes.add({ name: input.name, definition: input.definition });
        printProcessTable(proc);
      }),
    start: os
      .meta({ description: "Start a restarting process" })
      .input(v.tuple([v.pipe(ResourceTarget, v.description("Process name or index"))]))
      .handler(async ({ input, context: { client } }) => {
        const proc = await client.processes.start({ target: input[0] });
        printProcessTable(proc);
      }),
    stop: os
      .meta({ description: "Stop a restarting process" })
      .input(v.tuple([v.pipe(ResourceTarget, v.description("Process name or index"))]))
      .handler(async ({ input, context: { client } }) => {
        const proc = await client.processes.stop({ target: input[0] });
        printProcessTable(proc);
      }),
    restart: os
      .meta({
        description: "Restart a restarting process",
        aliases: { options: { force: "f" } },
      })
      .input(
        v.tuple([
          v.pipe(ResourceTarget, v.description("Process name or index")),
          v.object({
            force: v.optional(v.pipe(v.boolean(), v.description("Force restart"))),
          }),
        ]),
      )
      .handler(async ({ input, context: { client } }) => {
        const [target, options] = input;
        const proc = await client.processes.restart({ target, force: options.force });
        printProcessTable(proc);
      }),
    reload: os
      .meta({
        description: "Reload a restarting process definition",
        aliases: { options: { definition: "d", restartImmediately: "r" } },
      })
      .input(
        v.tuple([
          v.pipe(ResourceTarget, v.description("Process name or index")),
          v.object({
            definition: v.pipe(ProcessDefinition, v.description("Process definition JSON")),
            restartImmediately: v.optional(
              v.pipe(v.boolean(), v.description("Restart immediately after reload")),
            ),
          }),
        ]),
      )
      .handler(async ({ input, context: { client } }) => {
        const [target, options] = input;
        const proc = await client.processes.reload({
          target,
          definition: options.definition,
          restartImmediately: options.restartImmediately,
        });
        printProcessTable(proc);
      }),
    remove: os
      .meta({ description: "Remove a restarting process" })
      .input(v.tuple([v.pipe(ResourceTarget, v.description("Process name or index"))]))
      .handler(async ({ input, context: { client } }) => {
        await client.processes.remove({ target: input[0] });
        console.log("Process removed");
      }),
  }),

  // Tasks
  tasks: os.router({
    list: os.meta({ description: "List tasks" }).handler(async ({ context: { client } }) => {
      const tasks = await client.tasks.list();
      const table = new Table({ head: ["Id", "State", "Processes"], wordWrap: true });
      for (const task of tasks) {
        table.push([task.id, task.state, task.processNames.join(", ")]);
      }
      console.log(table.toString());
    }),
    get: os
      .meta({
        description: "Get a task by id or index",
        aliases: { options: { env: "e" } },
      })
      .input(
        v.tuple([
          v.pipe(ResourceTarget, v.description("Task id or index")),
          v.object({
            env: v.optional(
              v.pipe(v.boolean(), v.description("Show effective environment inherited by process")),
            ),
          }),
        ]),
      )
      .handler(async ({ input, context: { client } }) => {
        const [target, options] = input;
        const task = await client.tasks.get({ target, includeEffectiveEnv: options.env });
        printTaskDetails(task, { showEffectiveEnv: options.env });
      }),
    add: os
      .meta({ description: "Add a task", aliases: { options: { name: "n", definition: "d" } } })
      .input(
        v.object({
          name: v.pipe(v.string(), v.description("Task name")),
          definition: v.pipe(ProcessDefinition, v.description("Process definition JSON")),
        }),
      )
      .handler(async ({ input, context: { client } }) => {
        const task = await client.tasks.add({ name: input.name, definition: input.definition });
        printTaskTable(task);
      }),
    remove: os
      .meta({ description: "Remove a task by id or index" })
      .input(v.tuple([v.pipe(ResourceTarget, v.description("Task id or index"))]))
      .handler(async ({ input, context: { client } }) => {
        const task = await client.tasks.remove({ target: input[0] });
        printTaskTable(task);
      }),
  }),

  // Crons
  crons: os.router({
    list: os
      .meta({ description: "List cron processes" })
      .handler(async ({ context: { client } }) => {
        const crons = await client.crons.list();
        const table = new Table({
          head: ["Name", "State", "Runs", "Fails", "Next Run"],
          wordWrap: true,
        });
        for (const cron of crons) {
          table.push([cron.name, cron.state, cron.runCount, cron.failCount, cron.nextRun ?? "-"]);
        }
        console.log(table.toString());
      }),
    get: os
      .meta({
        description: "Get a cron process by name or index",
        aliases: { options: { env: "e" } },
      })
      .input(
        v.tuple([
          v.pipe(ResourceTarget, v.description("Cron name or index")),
          v.object({
            env: v.optional(
              v.pipe(v.boolean(), v.description("Show effective environment inherited by process")),
            ),
          }),
        ]),
      )
      .handler(async ({ input, context: { client } }) => {
        const [target, options] = input;
        const cron = await client.crons.get({ target, includeEffectiveEnv: options.env });
        printCronDetails(cron, { showEffectiveEnv: options.env });
      }),
    trigger: os
      .meta({ description: "Trigger a cron process" })
      .input(v.tuple([v.pipe(ResourceTarget, v.description("Cron name or index"))]))
      .handler(async ({ input, context: { client } }) => {
        const cron = await client.crons.trigger({ target: input[0] });
        printCronTable(cron);
      }),
    start: os
      .meta({ description: "Start a cron process" })
      .input(v.tuple([v.pipe(ResourceTarget, v.description("Cron name or index"))]))
      .handler(async ({ input, context: { client } }) => {
        const cron = await client.crons.start({ target: input[0] });
        printCronTable(cron);
      }),
    stop: os
      .meta({ description: "Stop a cron process" })
      .input(v.tuple([v.pipe(ResourceTarget, v.description("Cron name or index"))]))
      .handler(async ({ input, context: { client } }) => {
        const cron = await client.crons.stop({ target: input[0] });
        printCronTable(cron);
      }),
  }),
});

const client = createClient();
const cli = createCli({
  name: "pidnap",
  version: pkg.version,
  router: cliRouter,
  context: { client },
});

cli.run({
  formatError(error: any) {
    if (error?.cause?.code === "ECONNREFUSED") {
      return (
        `Failed to connect to RPC server, are you sure the server is running? If the Server is running of different url, use PIDNAP_RPC_URL environment variable to set it.\n` +
        format(error)
      );
    }
    return format(error);
  },
});
