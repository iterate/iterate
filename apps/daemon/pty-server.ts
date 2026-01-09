import type { Server as HttpServer } from "http";
import type { Server as HttpsServer } from "https";
import type { Http2SecureServer, Http2Server } from "http2";
import { homedir } from "os";
import pty from "@lydell/node-pty";
import { WebSocketServer, WebSocket } from "ws";

type ServerType = HttpServer | HttpsServer | Http2Server | Http2SecureServer;

export function setupPtyWebSocket(server: ServerType): void {
  // Cast to HttpServer for ws compatibility - ws only needs the upgrade event
  const wss = new WebSocketServer({ server: server as HttpServer, path: "/ws/pty" });

  wss.on("connection", (ws: WebSocket, req) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const cols = parseInt(url.searchParams.get("cols") || "80");
    const rows = parseInt(url.searchParams.get("rows") || "24");

    console.log(`[PTY] New connection: ${cols}x${rows}`);

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
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(`\r\n\x1b[33mShell exited (code: ${exitCode})\x1b[0m\r\n`);
        ws.close();
      }
    });

    // WebSocket -> PTY
    ws.on("message", (msg) => {
      const message = msg.toString("utf8");

      // Check for resize message
      if (message.startsWith("{")) {
        try {
          const parsed = JSON.parse(message);
          if (parsed.type === "resize") {
            ptyProcess.resize(parsed.cols, parsed.rows);
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
      console.log("[PTY] Connection closed");
      ptyProcess.kill();
    });

    ws.on("error", () => {
      // Ignore socket errors (connection reset, etc.)
    });
  });

  console.log("[PTY] WebSocket server ready at /ws/pty");
}
