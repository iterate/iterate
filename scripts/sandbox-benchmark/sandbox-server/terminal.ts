/**
 * Terminal WebSocket handler using node-pty
 *
 * Provides a PTY terminal over WebSocket for debugging sandbox instances.
 */

import type { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";

interface TerminalMessage {
  type: "input" | "resize";
  data?: string;
  cols?: number;
  rows?: number;
}

export function createTerminalHandler(wss: WebSocketServer): void {
  wss.on("connection", (ws: WebSocket) => {
    console.log("[terminal] Client connected");

    // Spawn a shell
    const shell = process.env.SHELL ?? "/bin/bash";
    const ptyProcess = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.env.HOME ?? "/",
      env: process.env as Record<string, string>,
    });

    console.log(`[terminal] Spawned ${shell} with PID ${ptyProcess.pid}`);

    // Send PTY output to WebSocket
    ptyProcess.onData((data: string) => {
      try {
        ws.send(data);
      } catch (error) {
        console.error("[terminal] Error sending data:", error);
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`[terminal] PTY exited with code ${exitCode}, signal ${signal}`);
      ws.close();
    });

    // Handle WebSocket messages
    ws.on("message", (message: Buffer) => {
      try {
        const msg = JSON.parse(message.toString()) as TerminalMessage;

        switch (msg.type) {
          case "input":
            if (msg.data) {
              ptyProcess.write(msg.data);
            }
            break;

          case "resize":
            if (msg.cols && msg.rows) {
              ptyProcess.resize(msg.cols, msg.rows);
            }
            break;

          default:
            console.warn("[terminal] Unknown message type:", msg);
        }
      } catch (error) {
        console.error("[terminal] Error parsing message:", error);
      }
    });

    ws.on("close", () => {
      console.log("[terminal] Client disconnected");
      ptyProcess.kill();
    });

    ws.on("error", (error) => {
      console.error("[terminal] WebSocket error:", error);
      ptyProcess.kill();
    });
  });

  console.log("[terminal] WebSocket handler ready");
}
