import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import type { createNodeWebSocket } from "@hono/node-ws";
import type { IPty } from "@lydell/node-pty";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { match } from "schematch";
import type { WebSocket } from "ws";
import { z } from "zod/v4";

const COMMAND_PREFIX = "\x00[command]\x00";
const PTY_TTL_MS = 10 * 60 * 1000;

const ResizePtyCommand = z.object({
  type: z.literal("resize"),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

const ExecPtyCommand = z.object({
  type: z.literal("exec"),
  command: z.string().min(1),
  autorun: z.boolean().optional(),
});

interface PtySession {
  id: string;
  ptyProcess: IPty;
  ws: WSContext<WebSocket> | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  headlessTerminal: {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    loadAddon(addon: unknown): void;
    dispose(): void;
  };
  serializeAddon: {
    serialize(): string;
  };
  pendingCommand: { command: string; autorun: boolean } | null;
  shellReady: boolean;
}

type UpgradeWebSocket = ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"];

const ptySessions = new Map<string, PtySession>();
const wsToSessionId = new Map<WSContext<WebSocket>, string>();

interface PtyRuntimeDeps {
  pty: typeof import("@lydell/node-pty");
  SerializeAddon: typeof import("@xterm/addon-serialize").SerializeAddon;
  XTermHeadless: typeof import("@xterm/headless");
}

let ptyRuntimeDepsPromise: Promise<PtyRuntimeDeps> | undefined;
const require = createRequire(import.meta.url);

async function getPtyRuntimeDeps(): Promise<PtyRuntimeDeps> {
  ptyRuntimeDepsPromise ??= Promise.resolve({
    pty: require("@lydell/node-pty") as typeof import("@lydell/node-pty"),
    SerializeAddon: require("@xterm/addon-serialize")
      .SerializeAddon as typeof import("@xterm/addon-serialize").SerializeAddon,
    XTermHeadless: require("@xterm/headless") as typeof import("@xterm/headless"),
  });
  return await ptyRuntimeDepsPromise;
}

function sendCommand(ws: WSContext<WebSocket>, command: object) {
  ws.send(COMMAND_PREFIX + JSON.stringify(command));
}

function scheduleCleanup(session: PtySession) {
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }

  session.cleanupTimer = setTimeout(() => {
    ptySessions.delete(session.id);
    session.headlessTerminal.dispose();
    session.ptyProcess.kill();
  }, PTY_TTL_MS);
}

function cancelCleanup(session: PtySession) {
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = null;
  }
}

async function spawnPtyProcess(): Promise<IPty> {
  const { pty } = await getPtyRuntimeDeps();
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

async function createSession(ptyProcess: IPty, ws: WSContext<WebSocket>): Promise<PtySession> {
  const { SerializeAddon, XTermHeadless } = await getPtyRuntimeDeps();
  const headlessTerminal = new XTermHeadless.Terminal({ scrollback: 10000, cols: 80, rows: 24 });
  const serializeAddon = new SerializeAddon();
  headlessTerminal.loadAddon(serializeAddon);

  const session: PtySession = {
    id: randomUUID(),
    ptyProcess,
    ws,
    cleanupTimer: null,
    headlessTerminal,
    serializeAddon,
    pendingCommand: null,
    shellReady: false,
  };

  ptySessions.set(session.id, session);
  wsToSessionId.set(ws, session.id);

  ptyProcess.onData((data: string) => {
    session.headlessTerminal.write(data);
    session.ws?.send(data);

    if (!session.shellReady) {
      session.shellReady = true;
      if (session.pendingCommand) {
        const { command, autorun } = session.pendingCommand;
        session.pendingCommand = null;
        session.ptyProcess.write(command);
        if (autorun) session.ptyProcess.write("\r\n");
        if (session.ws) {
          sendCommand(session.ws, { type: "commandExecuted" });
        }
      }
    }
  });

  ptyProcess.onExit(({ exitCode }: { exitCode: number; signal?: number }) => {
    if (!ptySessions.has(session.id)) {
      return;
    }

    cancelCleanup(session);
    session.headlessTerminal.dispose();
    ptySessions.delete(session.id);

    if (session.ws) {
      wsToSessionId.delete(session.ws);
      const message =
        exitCode === 0
          ? "\r\n\x1b[33mShell exited\x1b[0m\r\n"
          : `\r\n\x1b[31mShell exited (code: ${exitCode})\x1b[0m\r\n`;
      session.ws.send(message);
      session.ws.close(exitCode === 0 ? 1000 : 4000, "Process exited");
    }
  });

  return session;
}

function attachToSession(session: PtySession, ws: WSContext<WebSocket>) {
  cancelCleanup(session);
  if (session.ws) {
    wsToSessionId.delete(session.ws);
  }
  session.ws = ws;
  wsToSessionId.set(ws, session.id);

  const serializedBuffer = session.serializeAddon.serialize();
  if (serializedBuffer) {
    sendCommand(ws, { type: "buffer", data: serializedBuffer });
  }
}

function detachFromSession(session: PtySession) {
  if (session.ws) {
    wsToSessionId.delete(session.ws);
    session.ws = null;
  }
  scheduleCleanup(session);
}

export function createPtyRouter(params: { upgradeWebSocket: UpgradeWebSocket }) {
  const router = new Hono();

  router.get(
    "/ws",
    params.upgradeWebSocket((c) => {
      const url = new URL(c.req.url);
      const requestedPtyId = url.searchParams.get("ptyId");
      const initialCommand = url.searchParams.get("command");
      const initialAutorun = url.searchParams.get("autorun") === "true";

      return {
        onOpen(_event, ws) {
          let session: PtySession | undefined;

          if (requestedPtyId) {
            session = ptySessions.get(requestedPtyId);
            if (session) {
              attachToSession(session, ws);
              sendCommand(ws, { type: "ptyId", ptyId: session.id });
              return;
            }
          }

          void (async () => {
            try {
              const ptyProcess = await spawnPtyProcess();
              const nextSession = await createSession(ptyProcess, ws);
              if (initialCommand) {
                nextSession.pendingCommand = { command: initialCommand, autorun: initialAutorun };
              }
              sendCommand(ws, { type: "ptyId", ptyId: nextSession.id });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              ws.send(`\r\n\x1b[31mError: Failed to spawn process: ${message}\x1b[0m\r\n`);
              ws.close(1011, "Failed to spawn process");
            }
          })();
        },

        onMessage(event, ws) {
          const sessionId = wsToSessionId.get(ws);
          if (!sessionId) return;

          const session = ptySessions.get(sessionId);
          if (!session) return;

          const text = typeof event.data === "string" ? event.data : "";

          if (text.startsWith(COMMAND_PREFIX)) {
            try {
              const parsed = JSON.parse(text.slice(COMMAND_PREFIX.length)) as unknown;
              match(parsed)
                .case(ResizePtyCommand, ({ cols, rows }) => {
                  session.ptyProcess.resize(cols, rows);
                  session.headlessTerminal.resize(cols, rows);
                })
                .case(ExecPtyCommand, ({ command, autorun }) => {
                  session.ptyProcess.write(command);
                  if (autorun) session.ptyProcess.write("\r\n");
                })
                .case(z.object({ type: z.literal("exec") }), () => {
                  ws.send(`\r\n\x1b[31mError: exec command requires 'command' field\x1b[0m\r\n`);
                })
                .default(() => {});
              return;
            } catch (error) {
              ws.send(`\r\n\x1b[31mError: Failed to parse command: ${String(error)}\x1b[0m\r\n`);
              return;
            }
          }

          session.ptyProcess.write(text);
        },

        onClose(_event, ws) {
          const sessionId = wsToSessionId.get(ws);
          if (!sessionId) return;

          const session = ptySessions.get(sessionId);
          if (!session) return;

          detachFromSession(session);
        },

        onError(_event, ws) {
          const sessionId = wsToSessionId.get(ws);
          if (!sessionId) return;

          const session = ptySessions.get(sessionId);
          if (!session) return;

          detachFromSession(session);
        },
      };
    }),
  );

  return router;
}
