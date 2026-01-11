import { execSync, spawn } from "node:child_process";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { serve, type ServerType } from "@hono/node-server";
import * as pty from "node-pty";

const sessions = new Map<string, pty.IPty>();

export function getTmuxPath(): string {
  try {
    return execSync("which tmux", { encoding: "utf8" }).trim();
  } catch {
    return "/opt/homebrew/bin/tmux";
  }
}

function getShellPath(): string {
  if (process.platform === "win32") {
    return "powershell.exe";
  }

  try {
    const shells = ["zsh", "bash", "sh"];
    for (const shell of shells) {
      try {
        const path = execSync(`which ${shell}`, { encoding: "utf8" }).trim();
        if (path) return path;
      } catch {
        continue;
      }
    }
  } catch {
    // Fallback
  }

  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

function getTmuxSessionArgs(sessionName: string): string[] {
  return ["new-session", "-A", "-s", sessionName];
}

function runTmuxCommand(
  tmuxPath: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(tmuxPath, args, {
      env: process.env as Record<string, string>,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({
        exitCode: code ?? 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });

    proc.on("error", (err) => {
      resolve({
        exitCode: -1,
        stdout: "",
        stderr: err.message,
      });
    });
  });
}

export function createApp() {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.get(
    "/agents/:agentId/terminal",
    upgradeWebSocket((c) => {
      const agentId = c.req.param("agentId");
      const useTmux = c.req.query("tmux") === "true";

      return {
        onOpen(_evt, ws) {
          console.log(`[${agentId}] WebSocket connected (tmux: ${useTmux})`);

          try {
            let shell: string;
            let args: string[] = [];

            if (useTmux) {
              shell = getTmuxPath();
              args = getTmuxSessionArgs(agentId);
              console.log(`[${agentId}] Spawning tmux: ${shell} ${args.join(" ")}`);
            } else {
              shell = getShellPath();
              console.log(`[${agentId}] Spawning shell: ${shell}`);
            }

            const ptyProcess = pty.spawn(shell, args, {
              name: "xterm-256color",
              cols: 80,
              rows: 24,
              cwd: process.env.HOME,
              env: process.env as Record<string, string>,
            });

            sessions.set(agentId, ptyProcess);

            ptyProcess.onData((data) => {
              ws.send(JSON.stringify({ type: "output", data }));
            });

            ptyProcess.onExit(({ exitCode }) => {
              console.log(`[${agentId}] PTY exited with code ${exitCode}`);
              ws.close();
              sessions.delete(agentId);
            });
          } catch (err) {
            console.error(`[${agentId}] Failed to spawn PTY:`, err);
            ws.send(JSON.stringify({ type: "error", data: String(err) }));
            ws.close();
          }
        },

        onMessage(evt, _ws) {
          const ptyProcess = sessions.get(agentId);
          if (!ptyProcess) return;

          try {
            const msg = JSON.parse(evt.data.toString());

            switch (msg.type) {
              case "input":
                ptyProcess.write(msg.data);
                break;
              case "resize":
                ptyProcess.resize(msg.cols, msg.rows);
                break;
            }
          } catch {
            ptyProcess.write(evt.data.toString());
          }
        },

        onClose() {
          console.log(`[${agentId}] WebSocket closed`);
          const ptyProcess = sessions.get(agentId);
          if (ptyProcess) {
            ptyProcess.kill();
            sessions.delete(agentId);
          }
        },

        onError(evt) {
          console.error(`[${agentId}] WebSocket error:`, evt);
        },
      };
    }),
  );

  // Execute tmux command and return result (non-interactive)
  app.post("/tmux", async (c) => {
    const body = await c.req.json<{ args: string[] }>();
    const tmuxPath = getTmuxPath();

    const result = await runTmuxCommand(tmuxPath, body.args);
    if (result.exitCode === -1) {
      return c.json(result, 500);
    }
    return c.json(result);
  });

  // List tmux sessions
  app.get("/tmux/sessions", async (c) => {
    const tmuxPath = getTmuxPath();
    const result = await runTmuxCommand(tmuxPath, ["list-sessions", "-F", "#{session_name}"]);

    if (result.exitCode === 0) {
      const sessionList = result.stdout.split("\n").filter((s) => s.length > 0);
      return c.json({ sessions: sessionList });
    }
    return c.json({ sessions: [] });
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  return { app, injectWebSocket };
}

export function startServer(port = 3005): { server: ServerType; port: number } {
  const { app, injectWebSocket } = createApp();

  const server = serve(
    {
      fetch: app.fetch,
      port,
    },
    (info: { port: number }) => {
      console.log(`Server running on http://localhost:${info.port}`);
    },
  );

  injectWebSocket(server);

  return { server, port };
}

// Run server if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer(3005);
}
