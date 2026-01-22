/**
 * Callback server for receiving sandbox boot notifications
 *
 * Sandboxes POST to /callback/{sandboxId} when they boot.
 * We track when callbacks are received to measure boot time.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { BootCallback } from "../providers/types.ts";

export interface CallbackRecord {
  sandboxId: string;
  receivedAt: number; // Date.now()
  payload: BootCallback;
}

export interface CallbackServer {
  server: Server;
  port: number;
  callbacks: Map<string, CallbackRecord>;
  waitForCallback(sandboxId: string, timeoutMs: number): Promise<CallbackRecord>;
  close(): Promise<void>;
}

/**
 * Start the callback server on a random port
 */
export async function startCallbackServer(): Promise<CallbackServer> {
  const callbacks = new Map<string, CallbackRecord>();
  const waiters = new Map<
    string,
    { resolve: (record: CallbackRecord) => void; reject: (err: Error) => void }
  >();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS headers for sandbox requests
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Handle callback: POST /callback/{sandboxId}
    if (req.method === "POST" && req.url?.startsWith("/callback/")) {
      const sandboxId = req.url.replace("/callback/", "").split("?")[0];

      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });

      req.on("end", () => {
        try {
          const payload = JSON.parse(body) as BootCallback;
          const record: CallbackRecord = {
            sandboxId,
            receivedAt: Date.now(),
            payload,
          };

          console.log(`[callback-server] Received callback from sandbox: ${sandboxId}`);
          callbacks.set(sandboxId, record);

          // Resolve any waiters
          const waiter = waiters.get(sandboxId);
          if (waiter) {
            waiter.resolve(record);
            waiters.delete(sandboxId);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (error) {
          console.error(`[callback-server] Error parsing callback body:`, error);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
        }
      });

      return;
    }

    // Health check: GET /health
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", callbacks: callbacks.size }));
      return;
    }

    // 404 for everything else
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  // Start on random port
  const port = await new Promise<number>((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        resolve(address.port);
      }
    });
  });

  console.log(`[callback-server] Listening on port ${port}`);

  return {
    server,
    port,
    callbacks,

    waitForCallback(sandboxId: string, timeoutMs: number): Promise<CallbackRecord> {
      console.log(`[callback-server] Waiting for callback from: ${sandboxId}`);
      console.log(
        `[callback-server] Already received callbacks: ${Array.from(callbacks.keys()).join(", ") || "(none)"}`,
      );

      // Check if already received
      const existing = callbacks.get(sandboxId);
      if (existing) {
        console.log(`[callback-server] Found existing callback for ${sandboxId}`);
        return Promise.resolve(existing);
      }

      // Wait for callback
      console.log(`[callback-server] Waiting up to ${timeoutMs}ms for callback...`);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          console.log(
            `[callback-server] Timeout! Received callbacks: ${Array.from(callbacks.keys()).join(", ") || "(none)"}`,
          );
          waiters.delete(sandboxId);
          reject(new Error(`Timeout waiting for callback from sandbox ${sandboxId}`));
        }, timeoutMs);

        waiters.set(sandboxId, {
          resolve: (record) => {
            clearTimeout(timeout);
            resolve(record);
          },
          reject: (err) => {
            clearTimeout(timeout);
            reject(err);
          },
        });
      });
    },

    close(): Promise<void> {
      return new Promise((resolve) => {
        // Reject all pending waiters
        for (const [_sandboxId, waiter] of waiters) {
          waiter.reject(new Error("Server closing"));
        }
        waiters.clear();

        server.close(() => {
          console.log("[callback-server] Closed");
          resolve();
        });
      });
    },
  };
}
