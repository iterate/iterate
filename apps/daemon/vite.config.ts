// todo: consider deleting this/consolidating into apps/os2/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import devServer from "@hono/vite-dev-server";
import type { ViteDevServer } from "vite";
import { homedir } from "os";
import { WebSocketServer } from "ws";

// Dev plugin for PTY WebSocket (only runs in dev mode)
// Based on: https://github.com/coder/ghostty-web/blob/main/demo/bin/demo.js
function ptyWebSocketPlugin() {
  return {
    name: "pty-websocket",
    configureServer(server: ViteDevServer) {
      // Create WebSocket server with noServer mode (we handle upgrades manually)
      const wss = new WebSocketServer({ noServer: true });

      // Dynamically import node-pty to avoid issues in browser context
      import("@lydell/node-pty").then((pty) => {
        // Use prependListener so our handler runs before Vite's HMR WebSocket handler
        server.httpServer?.prependListener("upgrade", (req, socket, head) => {
          const pathname = req.url?.split("?")[0] || req.url || "";

          // Only handle /ws/pty - let everything else pass through to Vite
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

          console.log(`[PTY Dev] New connection: ${cols}x${rows}`);

          const shell = process.env.SHELL || "/bin/bash";
          const ptyProcess = pty.spawn(shell, [], {
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

          // PTY -> WebSocket
          ptyProcess.onData((data) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(data);
            }
          });

          ptyProcess.onExit(({ exitCode }) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(`\r\n\x1b[33mShell exited (code: ${exitCode})\x1b[0m\r\n`);
              ws.close();
            }
          });

          // WebSocket -> PTY
          ws.on("message", (data) => {
            const message = data.toString("utf8");

            // Check for resize message
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

            // Send to PTY
            ptyProcess.write(message);
          });

          ws.on("close", () => {
            console.log("[PTY Dev] Connection closed");
            ptyProcess.kill();
          });

          ws.on("error", () => {
            // Ignore socket errors (connection reset, etc.)
          });
        });

        console.log("[PTY Dev] WebSocket server ready at /ws/pty");
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    devServer({
      entry: "./index.ts",
      exclude: [
        // Only let Hono handle /agents, /platform, /edge - exclude everything else
        /^\/(?!agents|platform|edge).*/,
        /^\/@.+$/,
      ],
    }),
    ptyWebSocketPlugin(),
    // Serve /pty as a static HTML page
    {
      name: "pty-html",
      configureServer(server: ViteDevServer) {
        server.middlewares.use("/pty", async (req, res, next) => {
          if (req.url === "/" || req.url === "") {
            const fs = await import("fs");
            const path = await import("path");
            const html = fs.readFileSync(path.join(__dirname, "ui/pty.html"), "utf-8");
            const transformed = await server.transformIndexHtml("/pty", html);
            res.setHeader("Content-Type", "text/html");
            res.end(transformed);
          } else {
            next();
          }
        });
      },
    },
  ],
  build: {
    target: "esnext",
    outDir: "dist",
  },
  // SPA fallback for /ui/* routes
  appType: "spa",
});
