import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { Hooks, Message, Peer } from "crossws";
import { defineHooks } from "crossws";
import * as pty from "@lydell/node-pty";
import { SerializeAddon } from "@xterm/addon-serialize";
import XTermHeadless from "@xterm/headless/lib-headless/xterm-headless.js";
import { match } from "schematch";
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

export function createNodePtyHooks(): Partial<Hooks> {
  return defineHooks({
    open(peer) {
      const url = parsePeerUrl(peer);
      const requestedPtyId = url.searchParams.get("ptyId");
      const initialCommand = url.searchParams.get("command");
      const initialAutorun = url.searchParams.get("autorun") === "true";

      let session: PtySession | undefined;

      if (requestedPtyId) {
        session = ptySessions.get(requestedPtyId);
        if (session) {
          attachToSession(session, peer);
          sendCommand(peer, { type: "ptyId", ptyId: session.id });
          return;
        }
      }

      let ptyProcess: pty.IPty;
      try {
        ptyProcess = spawnPtyProcess();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        peer.send(`\r\n\x1b[31mError: Failed to spawn process: ${message}\x1b[0m\r\n`);
        peer.close(1011, "Failed to spawn process");
        return;
      }

      session = createSession(ptyProcess, peer);
      if (initialCommand) {
        session.pendingCommand = {
          command: initialCommand,
          autorun: initialAutorun,
        };
      }

      sendCommand(peer, { type: "ptyId", ptyId: session.id });
    },
    message(peer, message) {
      const session = getSessionForPeer(peer);
      if (!session) return;
      handlePtyMessage(session, message, peer);
    },
    close(peer) {
      const session = getSessionForPeer(peer);
      if (!session) return;
      detachFromSession(session);
    },
    error(peer) {
      const session = getSessionForPeer(peer);
      if (!session) return;
      detachFromSession(session);
    },
  });
}

interface HeadlessTerminalLike {
  loadAddon(addon: SerializeAddon): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

interface PtySession {
  id: string;
  ptyProcess: pty.IPty;
  peer: Peer | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  headlessTerminal: HeadlessTerminalLike;
  serializeAddon: SerializeAddon;
  pendingCommand: { command: string; autorun: boolean } | null;
  shellReady: boolean;
}

const ptySessions = new Map<string, PtySession>();
const peerToSessionId = new Map<string, string>();

function sendCommand(peer: Peer, command: object) {
  peer.send(COMMAND_PREFIX + JSON.stringify(command));
}

function scheduleCleanup(session: PtySession) {
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
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

function createSession(ptyProcess: pty.IPty, peer: Peer): PtySession {
  const headlessTerminal = new XTermHeadless.Terminal({
    scrollback: 10_000,
    cols: 80,
    rows: 24,
  }) as HeadlessTerminalLike;
  const serializeAddon = new SerializeAddon();
  headlessTerminal.loadAddon(serializeAddon);

  const session: PtySession = {
    id: randomUUID(),
    ptyProcess,
    peer,
    cleanupTimer: null,
    headlessTerminal,
    serializeAddon,
    pendingCommand: null,
    shellReady: false,
  };

  ptySessions.set(session.id, session);
  peerToSessionId.set(peer.id, session.id);

  ptyProcess.onData((data) => {
    session.headlessTerminal.write(data);
    session.peer?.send(data);

    if (!session.shellReady) {
      session.shellReady = true;

      if (session.pendingCommand) {
        const { command, autorun } = session.pendingCommand;
        session.pendingCommand = null;
        session.ptyProcess.write(command);
        if (autorun) session.ptyProcess.write("\r\n");
        if (session.peer) {
          sendCommand(session.peer, { type: "commandExecuted" });
        }
      }
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (!ptySessions.has(session.id)) return;

    cancelCleanup(session);
    session.headlessTerminal.dispose();
    ptySessions.delete(session.id);

    if (session.peer) {
      peerToSessionId.delete(session.peer.id);
      const message =
        exitCode === 0
          ? "\r\n\x1b[33mShell exited\x1b[0m\r\n"
          : `\r\n\x1b[31mShell exited (code: ${exitCode})\x1b[0m\r\n`;
      session.peer.send(message);
      session.peer.close(exitCode === 0 ? 1000 : 4000, "Process exited");
    }
  });

  return session;
}

function attachToSession(session: PtySession, peer: Peer) {
  cancelCleanup(session);

  if (session.peer) {
    peerToSessionId.delete(session.peer.id);
  }

  session.peer = peer;
  peerToSessionId.set(peer.id, session.id);

  const serializedBuffer = session.serializeAddon.serialize();
  if (serializedBuffer) {
    sendCommand(peer, { type: "buffer", data: serializedBuffer });
  }
}

function detachFromSession(session: PtySession) {
  if (session.peer) {
    peerToSessionId.delete(session.peer.id);
    session.peer = null;
  }

  scheduleCleanup(session);
}

function getSessionForPeer(peer: Peer) {
  const sessionId = peerToSessionId.get(peer.id);
  if (!sessionId) return undefined;
  return ptySessions.get(sessionId);
}

function parsePeerUrl(peer: Peer) {
  return new URL(peer.request.url);
}

function handlePtyMessage(session: PtySession, message: Message, peer: Peer) {
  const text = message.text();

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
      return;
    } catch (error) {
      peer.send(`\r\n\x1b[31mError: Failed to parse command: ${String(error)}\x1b[0m\r\n`);
      return;
    }
  }

  session.ptyProcess.write(text);
}
