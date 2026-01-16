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
import type { Agent, AgentType } from "../db/schema.ts";

const TMUX_SOCKET = join(process.cwd(), ".iterate", "tmux.sock");
const COMMAND_PREFIX = "\x00[command]\x00";

// OpenCode server URL
const OPENCODE_BASE_URL = "http://localhost:4096";

interface PtyConnection {
  ptyProcess: pty.IPty;
  connectionType: "tmux" | "agent" | "shell";
  identifier: string | null;
}

const ptyConnections = new Map<WSContext<WebSocket>, PtyConnection>();

/**
 * Get the CLI command and args for spawning an agent
 */
function getAgentCommand(agent: Agent): { command: string; args: string[] } {
  switch (agent.harnessType as AgentType) {
    case "claude-code":
      return { command: "claude", args: [] };

    case "opencode":
      // OpenCode uses attach command to connect to existing session
      if (!agent.harnessSessionId) {
        throw new Error("OpenCode agent has no session ID");
      }
      return {
        command: "opencode",
        args: ["attach", OPENCODE_BASE_URL, "--session", agent.harnessSessionId],
      };

    case "pi":
      return { command: "pi", args: [] };

    default:
      throw new Error(`Unknown agent type: ${agent.harnessType}`);
  }
}

export const ptyRouter = new Hono();

ptyRouter.get(
  "/ws",
  upgradeWebSocket((c) => {
    const url = new URL(c.req.url);
    const tmuxSessionName = url.searchParams.get("tmuxSession");
    const agentSlug = url.searchParams.get("agentSlug");

    return {
      async onOpen(_event, ws) {
        console.log(
          `[PTY] New connection${tmuxSessionName ? ` (tmux: ${tmuxSessionName})` : ""}${agentSlug ? ` (agent: ${agentSlug})` : ""}`,
        );

        let ptyProcess: pty.IPty;
        let connectionType: "tmux" | "agent" | "shell" = "shell";
        let identifier: string | null = null;

        try {
          if (agentSlug) {
            // ========== AGENT CONNECTION ==========
            // Spawn the agent CLI directly (no tmux)
            const [agent] = await db
              .select()
              .from(schema.agents)
              .where(eq(schema.agents.slug, agentSlug))
              .limit(1);

            if (!agent) {
              ws.send(`\x1b[31mAgent "${agentSlug}" not found.\x1b[0m\r\n`);
              ws.close(4000, "Agent not found");
              return;
            }

            const { command, args } = getAgentCommand(agent);

            console.log(
              `[PTY] Spawning agent CLI: ${command} ${args.join(" ")} in ${agent.workingDirectory}`,
            );

            ptyProcess = pty.spawn(command, args, {
              name: "xterm-256color",
              cwd: agent.workingDirectory,
              env: {
                ...process.env,
                TERM: "xterm-256color",
                COLORTERM: "truecolor",
              } as Record<string, string>,
            });

            connectionType = "agent";
            identifier = agentSlug;

            // Update agent status to running
            await db
              .update(schema.agents)
              .set({ status: "running" })
              .where(eq(schema.agents.slug, agentSlug));
          } else if (tmuxSessionName) {
            // ========== TMUX CONNECTION (for utility tools like btop, logs) ==========
            if (!hasTmuxSession(tmuxSessionName)) {
              const errorMsg = `Tmux session "${tmuxSessionName}" does not exist.\r\n\r\nThe session may have exited or was never created.`;
              ws.send(`\x1b[31m${errorMsg}\x1b[0m\r\n`);
              ws.close(4000, "Session does not exist");
              return;
            }

            // Configure tmux session
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

            connectionType = "tmux";
            identifier = tmuxSessionName;
          } else {
            // ========== SHELL CONNECTION ==========
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

            connectionType = "shell";
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[PTY] Failed to spawn process: ${message}`);
          ws.send(`\r\n\x1b[31mError: Failed to spawn process: ${message}\x1b[0m\r\n`);
          ws.close(1011, "Failed to spawn process");
          return;
        }

        ptyConnections.set(ws, { ptyProcess, connectionType, identifier });

        ptyProcess.onData((data) => {
          ws.send(data);
        });

        ptyProcess.onExit(async ({ exitCode }) => {
          console.log(`[PTY] Process exited: code=${exitCode}, type=${connectionType}`);

          // Update agent status when process exits
          if (connectionType === "agent" && identifier) {
            await db
              .update(schema.agents)
              .set({ status: "stopped" })
              .where(eq(schema.agents.slug, identifier));
          }

          if (exitCode === 0) {
            const exitMessage =
              connectionType === "tmux"
                ? "Tmux session detached"
                : connectionType === "agent"
                  ? "Agent exited"
                  : "Shell exited";
            ws.send(`\r\n\x1b[33m${exitMessage}\x1b[0m\r\n`);
            ws.close(1000, "Process exited normally");
          } else {
            const exitMessage =
              connectionType === "tmux"
                ? `Tmux session exited (code: ${exitCode})`
                : connectionType === "agent"
                  ? `Agent exited (code: ${exitCode})`
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
            `[PTY] Connection closed (${conn.connectionType}: ${conn.identifier || "none"})`,
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
