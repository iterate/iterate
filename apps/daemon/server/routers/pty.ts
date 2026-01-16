import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as pty from "@lydell/node-pty";
import type { WSContext } from "hono/ws";
import type { WebSocket } from "ws";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import XTermHeadless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { upgradeWebSocket } from "../utils/hono.ts";
import { hasTmuxSession, sendKeys } from "../tmux-control.ts";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { getHarness, getCommandString } from "../agent-harness.ts";

const TMUX_SOCKET = join(process.cwd(), ".iterate", "tmux.sock");
const COMMAND_PREFIX = "\x00[command]\x00";
const PTY_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface PtySession {
  id: string;
  ptyProcess: pty.IPty;
  tmuxSessionName: string | null;
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

async function spawnPtyProcess(
  tmuxSessionName: string | null,
  ws: WSContext<WebSocket>,
): Promise<pty.IPty | null> {
  if (tmuxSessionName) {
    if (!hasTmuxSession(tmuxSessionName)) {
      let commandInfo = "";
      const [agent] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.tmuxSession, tmuxSessionName))
        .limit(1);
      if (agent) {
        const harness = getHarness(agent.harnessType);
        const cmd = harness.getStartCommand(agent.workingDirectory, {
          prompt: agent.initialPrompt ?? undefined,
        });
        commandInfo = `\r\n\r\nCommand: cd "${agent.workingDirectory}" && ${getCommandString(cmd)}`;
      }
      const errorMsg = `Tmux session "${tmuxSessionName}" does not exist.${commandInfo}\r\n\r\nThe session may have exited or was never created.\r\nTry restarting the agent or check if the command failed to start.`;
      ws.send(`\x1b[31m${errorMsg}\x1b[0m\r\n`);
      ws.close(4000, "Session does not exist");
      return null;
    }

    spawnSync("tmux", ["-S", TMUX_SOCKET, "set-option", "-t", tmuxSessionName, "status", "off"]);
    spawnSync("tmux", ["-S", TMUX_SOCKET, "set-option", "-t", tmuxSessionName, "mouse", "on"]);

    return pty.spawn("tmux", ["-S", TMUX_SOCKET, "attach-session", "-t", tmuxSessionName], {
      name: "xterm-256color",
      cwd: homedir(),
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<
        string,
        string
      >,
    });
  }

  const shell = process.env.SHELL || "/bin/bash";
  return pty.spawn(shell, [], {
    name: "xterm-256color",
    cwd: homedir(),
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<
      string,
      string
    >,
  });
}

function createSession(
  ptyProcess: pty.IPty,
  tmuxSessionName: string | null,
  ws: WSContext<WebSocket>,
): PtySession {
  const headlessTerminal = new XTermHeadless.Terminal({ scrollback: 10000, cols: 80, rows: 24 });
  const serializeAddon = new SerializeAddon();
  headlessTerminal.loadAddon(serializeAddon);

  const session: PtySession = {
    id: randomUUID(),
    ptyProcess,
    tmuxSessionName,
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
        if (session.tmuxSessionName) {
          sendKeys(session.tmuxSessionName, command, autorun, true);
        } else {
          session.ptyProcess.write(command);
          if (autorun) session.ptyProcess.write("\r\n");
        }
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
          ? `\r\n\x1b[33m${tmuxSessionName ? "Tmux session detached" : "Shell exited"}\x1b[0m\r\n`
          : `\r\n\x1b[31m${tmuxSessionName ? `Tmux session exited (code: ${exitCode})` : `Shell exited (code: ${exitCode})`}\x1b[0m\r\n`;
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
    const tmuxSessionName = url.searchParams.get("tmuxSession");
    const requestedPtyId = url.searchParams.get("ptyId");
    const initialCommand = url.searchParams.get("command");
    const initialAutorun = url.searchParams.get("autorun") === "true";

    return {
      async onOpen(_event, ws) {
        console.log(
          `[PTY] New connection${tmuxSessionName ? ` (tmux: ${tmuxSessionName})` : ""}${requestedPtyId ? ` (ptyId: ${requestedPtyId})` : ""}${initialCommand ? ` (command: ${initialCommand.slice(0, 50)}...)` : ""}`,
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

        let ptyProcess: pty.IPty | null;
        try {
          ptyProcess = await spawnPtyProcess(tmuxSessionName, ws);
          if (!ptyProcess) return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[PTY] Failed to spawn process: ${message}`);
          ws.send(`\r\n\x1b[31mError: Failed to spawn process: ${message}\x1b[0m\r\n`);
          ws.close(1011, "Failed to spawn process");
          return;
        }

        session = createSession(ptyProcess, tmuxSessionName, ws);
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
            const parsed = JSON.parse(text.slice(COMMAND_PREFIX.length));
            if (parsed.type === "resize") {
              session.ptyProcess.resize(parsed.cols, parsed.rows);
              session.headlessTerminal.resize(parsed.cols, parsed.rows);
            } else if (parsed.type === "exec") {
              const { command, autorun } = parsed as { command?: string; autorun?: boolean };
              if (!command) {
                ws.send(`\r\n\x1b[31mError: exec command requires 'command' field\x1b[0m\r\n`);
                return;
              }
              if (session.tmuxSessionName) {
                sendKeys(session.tmuxSessionName, command, autorun === true, true);
              } else {
                session.ptyProcess.write(command);
                if (autorun) session.ptyProcess.write("\r\n");
              }
            }
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
