import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import * as pty from "@lydell/node-pty";
import type { WSContext } from "hono/ws";
import type { WebSocket } from "ws";
import { match } from "schematch";
import { Hono } from "hono";
import XTermHeadless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { z } from "zod/v4";
import { upgradeWebSocket } from "../utils/hono.ts";

const COMMAND_PREFIX = "\x00[command]\x00";
const PTY_TTL_MS = 10 * 60 * 1000; // 10 minutes

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

function sendCommand(ws: WSContext<WebSocket>, command: object) {
  ws.send(COMMAND_PREFIX + JSON.stringify(command));
}

function scheduleCleanup(session: PtySession) {
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }
  session.cleanupTimer = setTimeout(() => {
    console.log(`[PTY] Session ${session.id} expired after ${PTY_TTL_MS / 1000}s of inactivity`);
    // Delete from map first so onExit handler knows cleanup was already done
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

export const ptyRouter = new Hono();

function spawnPtyProcess(): pty.IPty {
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

    // Execute pending command once shell is ready (first data received)
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

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[PTY] Process exited: code=${exitCode}, session=${session.id}`);

    // If session is no longer in the map, cleanup was already handled by scheduleCleanup
    if (!ptySessions.has(session.id)) {
      return;
    }

    cancelCleanup(session);
    session.headlessTerminal.dispose();
    ptySessions.delete(session.id);

    if (session.ws) {
      wsToSessionId.delete(session.ws);
      const msg =
        exitCode === 0
          ? `\r\n\x1b[33mShell exited\x1b[0m\r\n`
          : `\r\n\x1b[31mShell exited (code: ${exitCode})\x1b[0m\r\n`;
      session.ws.send(msg);
      session.ws.close(exitCode === 0 ? 1000 : 4000, "Process exited");
    }
  });

  return session;
}

function attachToSession(session: PtySession, ws: WSContext<WebSocket>) {
  cancelCleanup(session);
  // Remove old ws from mapping before overwriting to prevent stale onClose handlers
  // from corrupting the new connection's state
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

ptyRouter.get(
  "/ws",
  upgradeWebSocket((c) => {
    const url = new URL(c.req.url);
    const requestedPtyId = url.searchParams.get("ptyId");
    const initialCommand = url.searchParams.get("command");
    const initialAutorun = url.searchParams.get("autorun") === "true";

    return {
      onOpen(_event, ws) {
        console.log(
          `[PTY] New connection${requestedPtyId ? ` (ptyId: ${requestedPtyId})` : ""}${initialCommand ? ` (command: ${initialCommand.slice(0, 50)}...)` : ""}`,
        );

        let session: PtySession | undefined;

        if (requestedPtyId) {
          session = ptySessions.get(requestedPtyId);
          if (session) {
            console.log(`[PTY] Reconnecting to existing session ${requestedPtyId}`);
            attachToSession(session, ws);
            sendCommand(ws, { type: "ptyId", ptyId: session.id });
            return;
          }
          console.log(`[PTY] Session ${requestedPtyId} not found, creating new`);
        }

        let ptyProcess: pty.IPty;
        try {
          ptyProcess = spawnPtyProcess();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[PTY] Failed to spawn process: ${message}`);
          ws.send(`\r\n\x1b[31mError: Failed to spawn process: ${message}\x1b[0m\r\n`);
          ws.close(1011, "Failed to spawn process");
          return;
        }

        session = createSession(ptyProcess, ws);
        if (initialCommand) {
          session.pendingCommand = { command: initialCommand, autorun: initialAutorun };
        }
        console.log(`[PTY] Created new session ${session.id}`);
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
              .case(z.object({ type: z.literal("exec") }), () => {
                ws.send(`\r\n\x1b[31mError: exec command requires 'command' field\x1b[0m\r\n`);
              })
              .default(() => {});
            return;
          } catch (error) {
            console.error(`[PTY] Failed to parse command: ${error}`);
            ws.send(`\r\n\x1b[31mError: Failed to parse command: ${error}\x1b[0m\r\n`);
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

        console.log(
          `[PTY] Connection closed, session ${session.id} will expire in ${PTY_TTL_MS / 1000}s`,
        );
        detachFromSession(session);
      },

      onError(event, ws) {
        console.error(`[PTY] WebSocket error:`, event);
        const sessionId = wsToSessionId.get(ws);
        if (!sessionId) return;
        const session = ptySessions.get(sessionId);
        if (!session) return;

        detachFromSession(session);
      },
    };
  }),
);
