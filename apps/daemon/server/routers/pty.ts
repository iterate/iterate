import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as pty from "@lydell/node-pty";
import type { WSContext } from "hono/ws";
import type { WebSocket } from "ws";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { upgradeWebSocket } from "../utils/hono.ts";
import { hasTmuxSession } from "../tmux-control.ts";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { getHarness, getCommandString } from "../agent-harness.ts";

const TMUX_SOCKET = join(process.cwd(), ".iterate", "tmux.sock");
const COMMAND_PREFIX = "\x00[command]\x00";

interface PtyConnection {
  ptyProcess: pty.IPty;
  tmuxSessionName: string | null;
}

const ptyConnections = new Map<WSContext<WebSocket>, PtyConnection>();

export const ptyRouter = new Hono();

ptyRouter.get(
  "/ws",
  upgradeWebSocket((c) => {
    const url = new URL(c.req.url);
    const tmuxSessionName = url.searchParams.get("tmuxSession");

    return {
      async onOpen(_event, ws) {
        console.log(
          `[PTY] New connection ${tmuxSessionName ? ` (tmux session: ${tmuxSessionName})` : ""}`,
        );

        let ptyProcess: pty.IPty;
        try {
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
              return;
            }

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
          console.log(`[PTY] Process exited: code=${exitCode}`);
          if (exitCode === 0) {
            const exitMessage = tmuxSessionName ? `Tmux session detached` : `Shell exited`;
            ws.send(`\r\n\x1b[33m${exitMessage}\x1b[0m\r\n`);
            ws.close(1000, "Process exited normally");
          } else {
            const exitMessage = tmuxSessionName
              ? `Tmux session exited (code: ${exitCode})`
              : `Shell exited (code: ${exitCode})`;
            ws.send(`\r\n\x1b[31m${exitMessage}\x1b[0m\r\n`);
            ws.close(4000, `Process exited with code ${exitCode}`);
          }
        });
      },

      onMessage(event, ws) {
        const conn = ptyConnections.get(ws);
        if (!conn) return;

        const text = typeof event.data === "string" ? event.data : "";

        if (text.startsWith(COMMAND_PREFIX)) {
          try {
            const parsed = JSON.parse(text.slice(COMMAND_PREFIX.length));
            if (parsed.type === "resize") {
              conn.ptyProcess.resize(parsed.cols, parsed.rows);
            }
            return;
          } catch (error) {
            console.error(`[PTY] Failed to parse command: ${error}`);
            ws.send(`\r\n\x1b[31mError: Failed to parse command: ${error}\x1b[0m\r\n`);
            return;
          }
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
