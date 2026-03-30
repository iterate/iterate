import { createRequire } from "node:module";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { WebSocketHooks } from "nitro/h3";
import { z } from "zod";
import type { PtyProcess } from "./pty.ts";

const COMMAND_PREFIX = "\x00[command]\x00";
const require = createRequire(import.meta.url);

interface TerminalRuntimeDeps {
  SerializeAddon: typeof import("@xterm/addon-serialize").SerializeAddon;
  XTermHeadless: typeof import("@xterm/headless");
}

let terminalRuntimeDeps: TerminalRuntimeDeps | undefined;

function getTerminalRuntimeDeps(): TerminalRuntimeDeps {
  terminalRuntimeDeps ??= {
    SerializeAddon: require("@xterm/addon-serialize")
      .SerializeAddon as typeof import("@xterm/addon-serialize").SerializeAddon,
    XTermHeadless: require("@xterm/headless") as typeof import("@xterm/headless"),
  };

  return terminalRuntimeDeps;
}

interface TerminalSocket {
  send(value: string): void;
  close(code?: number, reason?: string): void;
}

interface TerminalSession {
  id: string;
  ptyProcess: PtyProcess;
  socket: TerminalSocket | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  headlessTerminal: {
    loadAddon(addon: SerializeAddon): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    dispose(): void;
  };
  serializeAddon: SerializeAddon;
  pendingCommand: { command: string; autorun: boolean } | null;
  shellReady: boolean;
}

const terminalSessions = new Map<string, TerminalSession>();

export function createTerminalWebSocketHooks(options: {
  request: Request;
  spawn: () => PtyProcess;
}): Partial<WebSocketHooks> {
  let session: TerminalSession | null = null;

  return {
    open(peer) {
      session = resolveSession({
        request: options.request,
        socket: createPeerSocket(peer),
        session,
        spawn: options.spawn,
      });
    },
    message(peer, message) {
      const socket = createPeerSocket(peer);
      session = resolveSession({
        request: options.request,
        socket,
        session,
        spawn: options.spawn,
      });

      const text = readMessageText(message);
      if (!session || text === undefined) return;

      if (text.startsWith(COMMAND_PREFIX)) {
        handleCommandMessage(session, socket, text);
        return;
      }

      session.ptyProcess.write(text);
    },
    close() {
      if (!session) return;
      detachFromSession(session);
    },
    error() {
      if (!session) return;
      detachFromSession(session);
    },
  };
}

function sendCommand(socket: TerminalSocket, command: object) {
  socket.send(COMMAND_PREFIX + JSON.stringify(command));
}

function createPeerSocket(peer: {
  send(value: string): void;
  close(code?: number, reason?: string): void;
}): TerminalSocket {
  return {
    send(value: string) {
      peer.send(value);
    },
    close(code?: number, reason?: string) {
      peer.close(code, reason);
    },
  };
}

function readMessageText(message: { text?: () => string } | string) {
  if (typeof message === "string") {
    return message;
  }

  if (typeof message.text === "function") {
    return message.text();
  }

  return undefined;
}

function scheduleCleanup(session: TerminalSession) {
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(
    () => {
      terminalSessions.delete(session.id);
      session.headlessTerminal.dispose();
      session.ptyProcess.kill();
    },
    10 * 60 * 1000,
  );
}

function cancelCleanup(session: TerminalSession) {
  if (!session.cleanupTimer) return;
  clearTimeout(session.cleanupTimer);
  session.cleanupTimer = null;
}

function createSession(socket: TerminalSocket, spawn: () => PtyProcess) {
  const { SerializeAddon, XTermHeadless } = getTerminalRuntimeDeps();
  const headlessTerminal = new XTermHeadless.Terminal({
    scrollback: 10_000,
    cols: 80,
    rows: 24,
  }) as TerminalSession["headlessTerminal"];
  const serializeAddon = new SerializeAddon();
  headlessTerminal.loadAddon(serializeAddon);

  const session: TerminalSession = {
    id: crypto.randomUUID(),
    ptyProcess: spawn(),
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
  spawn: () => PtyProcess;
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
    const nextSession = createSession(options.socket, options.spawn);
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
  }
}
