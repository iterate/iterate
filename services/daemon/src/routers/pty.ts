import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import * as pty from "@lydell/node-pty";
import { SerializeAddon } from "@xterm/addon-serialize";
import XTermHeadless from "@xterm/headless";
import { Hono } from "hono";
import { match } from "schematch";
import type { WSContext } from "hono/ws";
import type { WebSocket } from "ws";
import { z } from "zod/v4";
import { upgradeWebSocket } from "../utils/hono.ts";

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
  ptyProcess: pty.IPty;
  ws: WSContext<WebSocket> | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  headlessTerminal: XTermHeadless.Terminal;
  serializeAddon: SerializeAddon;
  pendingCommand: { command: string; autorun: boolean } | null;
  shellReady: boolean;
}

const ptySessions = new Map<string, PtySession>();
const wsToSessionId = new Map<WSContext<WebSocket>, string>();

function sendCommand(ws: WSContext<WebSocket>, command: object): void {
  ws.send(COMMAND_PREFIX + JSON.stringify(command));
}

function scheduleCleanup(session: PtySession): void {
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }
  session.cleanupTimer = setTimeout(() => {
    ptySessions.delete(session.id);
    session.headlessTerminal.dispose();
    session.ptyProcess.kill();
  }, PTY_TTL_MS);
}

function cancelCleanup(session: PtySession): void {
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = null;
  }
}

function spawnPtyProcess(): pty.IPty {
  const shell = process.env.SHELL || "/bin/bash";
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  } as Record<string, string>;

  return pty.spawn(shell, [], {
    name: "xterm-256color",
    cwd: homedir(),
    env,
  });
}

function createSession(ptyProcess: pty.IPty, ws: WSContext<WebSocket>): PtySession {
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

  ptyProcess.onData((data) => {
    session.headlessTerminal.write(data);
    if (session.ws) {
      session.ws.send(data);
    }

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

  ptyProcess.onExit(() => {
    if (!ptySessions.has(session.id)) {
      return;
    }

    cancelCleanup(session);
    session.headlessTerminal.dispose();
    ptySessions.delete(session.id);

    if (session.ws) {
      wsToSessionId.delete(session.ws);
      session.ws.close(1000, "Process exited");
    }
  });

  return session;
}

function attachToSession(session: PtySession, ws: WSContext<WebSocket>): void {
  cancelCleanup(session);
  const previousWs = session.ws;
  if (previousWs && previousWs !== ws) {
    wsToSessionId.delete(previousWs);
    try {
      previousWs.close(1000, "Reattached from another client");
    } catch {
      // ignore close errors from stale sockets
    }
  }
  session.ws = ws;
  wsToSessionId.set(ws, session.id);

  const serializedBuffer = session.serializeAddon.serialize();
  if (serializedBuffer) {
    sendCommand(ws, { type: "buffer", data: serializedBuffer });
  }
}

function detachFromSession(session: PtySession): void {
  if (session.ws) {
    wsToSessionId.delete(session.ws);
    session.ws = null;
  }
  scheduleCleanup(session);
}

export const ptyRouter = new Hono();

ptyRouter.get(
  "/ws",
  upgradeWebSocket((c) => {
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

        const ptyProcess = spawnPtyProcess();
        session = createSession(ptyProcess, ws);
        if (initialCommand) {
          session.pendingCommand = { command: initialCommand, autorun: initialAutorun };
        }
        sendCommand(ws, { type: "ptyId", ptyId: session.id });
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
              .default(() => {});
          } catch {
            // ignore malformed command messages
          }
          return;
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
