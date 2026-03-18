import { randomUUID } from "node:crypto";
import type { RequestListener } from "node:http";
import { homedir } from "node:os";
import * as pty from "@lydell/node-pty";
import { createNodeWebSocket } from "@hono/node-ws";
import { getRequestListener } from "@hono/node-server";
import { SerializeAddon } from "@xterm/addon-serialize";
import XTermHeadless from "@xterm/headless/lib-headless/xterm-headless.js";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { Hono } from "hono";
import { z } from "zod";
import type { ExampleDeps } from "./api/context.ts";
import * as schema from "./api/db/schema.ts";
import { exampleApp } from "./api/app.ts";
import type { ExampleTerminalDep } from "./api/terminal.ts";
import { ExampleAppEnv, ExampleNodeEnv } from "./env.ts";

const COMMAND_PREFIX = "\x00[command]\x00";
const TERMINAL_TTL_MS = 10 * 60 * 1000;

const ResizeCommand = z.object({
  type: z.literal("resize"),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

const ExecCommand = z.object({
  type: z.literal("exec"),
  command: z.string().min(1),
  autorun: z.boolean().optional(),
});

interface HeadlessTerminalLike {
  loadAddon(addon: SerializeAddon): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

interface TerminalSocket {
  send(value: string): void;
  close(code?: number, reason?: string): void;
}

interface TerminalSession {
  id: string;
  ptyProcess: pty.IPty;
  socket: TerminalSocket | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  headlessTerminal: HeadlessTerminalLike;
  serializeAddon: SerializeAddon;
  pendingCommand: { command: string; autorun: boolean } | null;
  shellReady: boolean;
}

const terminalSessions = new Map<string, TerminalSession>();

function sendCommand(socket: TerminalSocket, command: object) {
  socket.send(COMMAND_PREFIX + JSON.stringify(command));
}

function scheduleCleanup(session: TerminalSession) {
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => {
    terminalSessions.delete(session.id);
    session.headlessTerminal.dispose();
    session.ptyProcess.kill();
  }, TERMINAL_TTL_MS);
}

function cancelCleanup(session: TerminalSession) {
  if (!session.cleanupTimer) return;
  clearTimeout(session.cleanupTimer);
  session.cleanupTimer = null;
}

function spawnPtyProcess() {
  const shell = process.env.SHELL || "/bin/bash";
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  } as Record<string, string>;

  if (env.FORCE_COLOR && env.NO_COLOR) {
    delete env.NO_COLOR;
  }

  return pty.spawn(shell, [], {
    name: "xterm-256color",
    cwd: homedir(),
    env,
  });
}

function createSession(socket: TerminalSocket) {
  const headlessTerminal = new XTermHeadless.Terminal({
    scrollback: 10_000,
    cols: 80,
    rows: 24,
  }) as HeadlessTerminalLike;
  const serializeAddon = new SerializeAddon();
  headlessTerminal.loadAddon(serializeAddon);

  const session: TerminalSession = {
    id: randomUUID(),
    ptyProcess: spawnPtyProcess(),
    socket,
    cleanupTimer: null,
    headlessTerminal,
    serializeAddon,
    pendingCommand: null,
    shellReady: false,
  };

  terminalSessions.set(session.id, session);

  session.ptyProcess.onData((data) => {
    session.headlessTerminal.write(data);
    session.socket?.send(data);

    if (!session.shellReady) {
      session.shellReady = true;
      if (session.pendingCommand) {
        const pending = session.pendingCommand;
        session.pendingCommand = null;
        session.ptyProcess.write(pending.command);
        if (pending.autorun) session.ptyProcess.write("\r\n");
        if (session.socket) {
          sendCommand(session.socket, { type: "commandExecuted" });
        }
      }
    }
  });

  session.ptyProcess.onExit(({ exitCode }) => {
    if (!terminalSessions.has(session.id)) return;

    cancelCleanup(session);
    session.headlessTerminal.dispose();
    terminalSessions.delete(session.id);

    if (session.socket) {
      const message =
        exitCode === 0
          ? "\r\n\x1b[33mShell exited\x1b[0m\r\n"
          : `\r\n\x1b[31mShell exited (code: ${exitCode})\x1b[0m\r\n`;
      session.socket.send(message);
      session.socket.close(exitCode === 0 ? 1000 : 4000, "Process exited");
    }
  });

  return session;
}

function attachToSession(session: TerminalSession, socket: TerminalSocket) {
  cancelCleanup(session);
  session.socket = socket;

  const serializedBuffer = session.serializeAddon.serialize();
  if (serializedBuffer) {
    sendCommand(socket, { type: "buffer", data: serializedBuffer });
  }
}

function detachFromSession(session: TerminalSession) {
  session.socket = null;
  scheduleCleanup(session);
}

function resolveSession(options: {
  request: Request;
  socket: TerminalSocket;
  session: TerminalSession | null;
}) {
  if (options.session) return options.session;

  const url = new URL(options.request.url);
  const requestedTerminalId = url.searchParams.get("ptyId");

  if (requestedTerminalId) {
    const resumedSession = terminalSessions.get(requestedTerminalId);
    if (resumedSession) {
      attachToSession(resumedSession, options.socket);
      sendCommand(options.socket, { type: "ptyId", ptyId: resumedSession.id });
      return resumedSession;
    }
  }

  try {
    const nextSession = createSession(options.socket);
    const initialCommand = url.searchParams.get("command");
    const initialAutorun = url.searchParams.get("autorun") === "true";

    if (initialCommand) {
      nextSession.pendingCommand = {
        command: initialCommand,
        autorun: initialAutorun,
      };
    }

    sendCommand(options.socket, { type: "ptyId", ptyId: nextSession.id });
    return nextSession;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.socket.send(`\r\n\x1b[31mError: Failed to spawn process: ${message}\x1b[0m\r\n`);
    options.socket.close(1011, "Failed to spawn process");
    return null;
  }
}

function handleCommandMessage(session: TerminalSession, socket: TerminalSocket, raw: string) {
  try {
    const parsed = JSON.parse(raw.slice(COMMAND_PREFIX.length)) as unknown;

    const resize = ResizeCommand.safeParse(parsed);
    if (resize.success) {
      session.ptyProcess.resize(resize.data.cols, resize.data.rows);
      session.headlessTerminal.resize(resize.data.cols, resize.data.rows);
      return;
    }

    const exec = ExecCommand.safeParse(parsed);
    if (exec.success) {
      session.ptyProcess.write(exec.data.command);
      if (exec.data.autorun) {
        session.ptyProcess.write("\r\n");
      }
      return;
    }
  } catch (error) {
    socket.send(`\r\n\x1b[31mError: Failed to parse command: ${String(error)}\x1b[0m\r\n`);
    return;
  }
}

export function createNodeTerminalDep(): ExampleTerminalDep {
  return {
    createWebSocketEvents({ request }) {
      let session: TerminalSession | null = null;
      let socket: TerminalSocket | null = null;

      return {
        onMessage(event, ws) {
          socket = ws;

          session = resolveSession({
            request,
            socket,
            session,
          });

          if (!session) return;
          if (typeof event.data !== "string") return;

          if (event.data.startsWith(COMMAND_PREFIX)) {
            handleCommandMessage(session, socket, event.data);
            return;
          }

          session.ptyProcess.write(event.data);
        },
        onClose() {
          if (!session) return;
          detachFromSession(session);
        },
        onError() {
          if (!session) return;
          detachFromSession(session);
        },
      };
    },
  };
}

export async function createExampleNodeRuntime(options?: { env?: ExampleNodeEnv }) {
  const env = options?.env ?? ExampleNodeEnv.parse(process.env);
  const appEnv = ExampleAppEnv.parse(env);

  const db = drizzle(env.EXAMPLE_DB_PATH, { schema });
  db.$client.pragma("journal_mode = WAL");
  migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

  const deps: ExampleDeps = {
    env: appEnv,
    db,
    terminal: createNodeTerminalDep(),
  };

  return {
    appEnv,
    db,
    deps,
    env,
  };
}

/**
 * Build the Node API surface for the example app.
 *
 * Returns a `{ requestListener, injectWebSocket }` pair that the
 * `mountNodeApi` Vite plugin (or a standalone Node server) can consume.
 * This is the single Node runtime composition boundary: Hono setup,
 * websocket wiring, env parsing, and runtime deps all live here.
 */
export async function exampleNodeApi(options?: { env?: ExampleNodeEnv }) {
  const runtime = await createExampleNodeRuntime(options);

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  await exampleApp.mount({
    app,
    getDeps: () => runtime.deps,
    upgradeWebSocket,
  });

  const requestListener: RequestListener = getRequestListener((request) => app.fetch(request), {
    overrideGlobalObjects: false,
    errorHandler: (error) => {
      throw toError(error);
    },
  });

  return {
    app,
    ...runtime,
    injectWebSocket,
    requestListener,
  };
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
