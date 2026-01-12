import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as pty from "@lydell/node-pty";
import type { IPty } from "@lydell/node-pty";
import type { WSContext } from "hono/ws";
import type { WebSocket } from "ws";
import { Hono } from "hono";
import { upgradeWebSocket } from "../utils/hono.ts";

const TMUX_SOCKET = join(process.cwd(), ".iterate", "tmux.sock");

interface PtyConnection {
  ptyProcess: IPty;
  tmuxSessionName: string | null;
}

const ptyConnections = new Map<WSContext<WebSocket>, PtyConnection>();

export const ptyRouter = new Hono();

ptyRouter.get(
  "/ws",
  upgradeWebSocket((c) => {
    const url = new URL(c.req.url);
    const cols = parseInt(url.searchParams.get("cols") || "80");
    const rows = parseInt(url.searchParams.get("rows") || "24");
    const tmuxSessionName = url.searchParams.get("tmuxSession");

    return {
      onOpen(_event, ws) {
        console.log(
          `[PTY] New connection: ${cols}x${rows}${tmuxSessionName ? ` (tmux session: ${tmuxSessionName})` : ""}`,
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
            spawnSync("tmux", [
              "-S",
              TMUX_SOCKET,
              "set-option",
              "-t",
              tmuxSessionName,
              "mouse",
              "on",
            ]);

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
              cwd: homedir(),
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
          ws.send(`\r\n\x1b[31mError: Failed to spawn process: ${message}\x1b[0m\r\n`);
          ws.close(1011, "Failed to spawn process");
          return;
        }

        ptyConnections.set(ws, { ptyProcess, tmuxSessionName });

        ptyProcess.onData((data) => {
          ws.send(data);
        });

        ptyProcess.onExit(({ exitCode }) => {
          const exitMessage = tmuxSessionName
            ? `Tmux session detached/exited (code: ${exitCode})`
            : `Shell exited (code: ${exitCode})`;
          ws.send(`\r\n\x1b[33m${exitMessage}\x1b[0m\r\n`);
          ws.close(1000, `Process exited with code ${exitCode}`);
        });
      },

      onMessage(event, ws) {
        const conn = ptyConnections.get(ws);
        if (!conn) return;

        const text = typeof event.data === "string" ? event.data : "";

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

      onClose(_event, ws) {
        const conn = ptyConnections.get(ws);
        if (conn) {
          console.log(
            `[PTY] Connection closed${conn.tmuxSessionName ? ` (tmux session: ${conn.tmuxSessionName})` : ""}`,
          );
          conn.ptyProcess.kill();
          ptyConnections.delete(ws);
        }
      },

      onError(event, ws) {
        console.error(`[PTY] WebSocket error:`, event);
        const conn = ptyConnections.get(ws);
        if (conn) {
          conn.ptyProcess.kill();
          ptyConnections.delete(ws);
        }
      },
    };
  }),
);
