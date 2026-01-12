import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as pty from "@lydell/node-pty";
import type { IPty } from "@lydell/node-pty";
import { defineWebSocketHandler } from "nitro/h3";

const TMUX_SOCKET = join(process.cwd(), ".iterate", "tmux.sock");

interface PtyConnection {
  ptyProcess: IPty;
  tmuxSessionName: string | null;
  hasSentInitialCommand: boolean;
  initialCommand: string | null;
}

const connections = new Map<string, PtyConnection>();

export default defineWebSocketHandler({
  open(peer) {
    const url = new URL(peer.request?.url || "", "http://localhost");
    const cols = parseInt(url.searchParams.get("cols") || "80");
    const rows = parseInt(url.searchParams.get("rows") || "24");
    const tmuxSessionName = url.searchParams.get("tmuxSession");
    const initialCommand = url.searchParams.get("initialCommand");

    console.log(
      `[PTY] New connection: ${cols}x${rows}${tmuxSessionName ? ` (tmux session: ${tmuxSessionName})` : ""}${initialCommand ? ` (cmd: ${initialCommand})` : ""}`,
    );

    let ptyProcess: IPty;
    try {
      if (tmuxSessionName) {
        spawnSync("tmux", [
          "-S",
          TMUX_SOCKET,
          "set-option",
          "-t",
          tmuxSessionName,
          "status",
          "off",
        ]);
        spawnSync("tmux", ["-S", TMUX_SOCKET, "set-option", "-t", tmuxSessionName, "mouse", "on"]);

        ptyProcess = pty.spawn(
          "tmux",
          ["-S", TMUX_SOCKET, "attach-session", "-t", tmuxSessionName],
          {
            name: "xterm-256color",
            cols,
            rows,
            cwd: homedir(),
            env: {
              ...process.env,
              TERM: "xterm-256color",
              COLORTERM: "truecolor",
            } as Record<string, string>,
          },
        );
      } else {
        const shell = process.env.SHELL || "/bin/bash";
        ptyProcess = pty.spawn(shell, [], {
          name: "xterm-256color",
          cols,
          rows,
          cwd: process.cwd(),
          env: {
            ...process.env,
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
          } as Record<string, string>,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[PTY] Failed to spawn process: ${message}`);
      peer.send(`\r\n\x1b[31mError: Failed to spawn process: ${message}\x1b[0m\r\n`);
      peer.close(1011, "Failed to spawn process");
      return;
    }

    const conn: PtyConnection = {
      ptyProcess,
      tmuxSessionName,
      hasSentInitialCommand: false,
      initialCommand,
    };
    connections.set(peer.id, conn);

    ptyProcess.onData((data) => {
      peer.send(data);

      if (!conn.hasSentInitialCommand && conn.initialCommand) {
        conn.hasSentInitialCommand = true;
        setTimeout(() => {
          ptyProcess.write(conn.initialCommand + "\n");
        }, 100);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      const exitMessage = tmuxSessionName
        ? `Tmux session detached/exited (code: ${exitCode})`
        : `Shell exited (code: ${exitCode})`;
      peer.send(`\r\n\x1b[33m${exitMessage}\x1b[0m\r\n`);
      peer.close(1000, `Process exited with code ${exitCode}`);
    });
  },

  message(peer, message) {
    const conn = connections.get(peer.id);
    if (!conn) return;

    const text = message.text();

    try {
      const parsed = JSON.parse(text);
      if (parsed.type === "resize") {
        conn.ptyProcess.resize(parsed.cols, parsed.rows);
        return;
      }
    } catch {
      // Not JSON, treat as terminal input
    }

    conn.ptyProcess.write(text);
  },

  close(peer) {
    const conn = connections.get(peer.id);
    if (conn) {
      console.log(
        `[PTY] Connection closed${conn.tmuxSessionName ? ` (tmux session: ${conn.tmuxSessionName})` : ""}`,
      );
      conn.ptyProcess.kill();
      connections.delete(peer.id);
    }
  },

  error(peer, error) {
    console.error(`[PTY] WebSocket error:`, error);
    const conn = connections.get(peer.id);
    if (conn) {
      conn.ptyProcess.kill();
      connections.delete(peer.id);
    }
  },
});
