import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import viteTsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
import type { ViteDevServer } from "vite";
import { WebSocketServer } from "ws";

const TMUX_SOCKET = join(process.cwd(), ".iterate", "tmux.sock");

function ptyWebSocketPlugin() {
  return {
    name: "pty-websocket",
    configureServer(server: ViteDevServer) {
      const wss = new WebSocketServer({ noServer: true });

      import("@lydell/node-pty").then((pty) => {
        server.httpServer?.prependListener("upgrade", (req, socket, head) => {
          const pathname = req.url?.split("?")[0] || req.url || "";

          if (pathname === "/ws/pty") {
            if (!socket.destroyed && !socket.readableEnded) {
              wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit("connection", ws, req);
              });
            }
          }
        });

        wss.on("connection", (ws, req) => {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const cols = parseInt(url.searchParams.get("cols") || "80");
          const rows = parseInt(url.searchParams.get("rows") || "24");
          const tmuxSessionName = url.searchParams.get("tmuxSession");

          console.log(
            `[PTY Dev] New connection: ${cols}x${rows}${tmuxSessionName ? ` (tmux session: ${tmuxSessionName})` : ""}`,
          );

          let ptyProcess;
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
              // Fallback to default shell
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
            console.error(`[PTY Dev] Failed to spawn process: ${message}`);
            ws.send(`\r\n\x1b[31mError: Failed to spawn process: ${message}\x1b[0m\r\n`);
            ws.close();
            return;
          }

          ptyProcess.onData((data) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(data);
            }
          });

          ptyProcess.onExit(({ exitCode }) => {
            if (ws.readyState === ws.OPEN) {
              const exitMessage = tmuxSessionName
                ? `Tmux session detached/exited (code: ${exitCode})`
                : `Shell exited (code: ${exitCode})`;
              ws.send(`\r\n\x1b[33m${exitMessage}\x1b[0m\r\n`);
              ws.close();
            }
          });

          ws.on("message", (data) => {
            const message = data.toString("utf8");

            if (message.startsWith("{")) {
              try {
                const msg = JSON.parse(message);
                if (msg.type === "resize") {
                  ptyProcess.resize(msg.cols, msg.rows);
                  return;
                }
              } catch {
                // Not JSON, treat as input
              }
            }

            ptyProcess.write(message);
          });

          ws.on("close", () => {
            console.log(
              `[PTY Dev] Connection closed${tmuxSessionName ? ` (tmux session: ${tmuxSessionName})` : ""}`,
            );
            ptyProcess.kill();
          });

          ws.on("error", () => {
            // Ignore socket errors
          });
        });

        console.log("[PTY Dev] WebSocket server ready at /ws/pty");
      });
    },
  };
}

const config = defineConfig({
  plugins: [
    devtools(),
    nitro({
      preset: "node_server",
      output: {
        dir: "dist",
      },
    }),
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    ptyWebSocketPlugin(),
  ],
});

export default config;
