/**
 * Example service definition wrapping a Go TCP echo server.
 *
 * Demonstrates the hybrid proxy: raw TCP traffic goes straight to the Go
 * process, while managed HTTP paths (/service/health, /openapi.json) are
 * handled by our TS layer.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Hono } from "hono";
import { z } from "zod/v4";
import { defineService } from "./define-service.ts";
import { createHybridProxy, type HybridProxyHandle } from "./hybrid-proxy.ts";

export const echoService = defineService({
  slug: "echo",
  version: "0.1.0",
  configSchema: z.object({
    binaryPath: z.string(),
  }),

  async start(config) {
    // 1. Start the Go TCP echo server on an ephemeral port
    const goProc = spawn(config.binaryPath, [], {
      env: { ...process.env, PORT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const innerPort = await waitForPort(goProc);

    // 2. Create our managed Hono app (health, openapi)
    const app = new Hono();
    app.get("/service/health", (c) => c.json({ status: "ok", slug: "echo", pid: goProc.pid }));
    app.get("/openapi.json", (c) =>
      c.json({
        openapi: "3.0.0",
        info: { title: "Echo TCP Service", version: "0.1.0" },
        paths: {},
      }),
    );

    // 3. Create hybrid proxy: managed HTTP routes go to Hono, everything else L4 to Go
    const proxy = await createHybridProxy({ innerPort, app });

    // 4. Signal handling
    const shutdown = () => {
      proxy.close();
      goProc.kill("SIGTERM");
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    return { target: `127.0.0.1:${proxy.port}` };
  },
});

/** Wait for the Go process to print "LISTENING:<port>" on stdout */
function waitForPort(proc: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Go process did not start in time")), 10_000);

    let buffer = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/LISTENING:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(parseInt(match[1], 10));
      }
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(`[echo-go] ${chunk}`);
    });

    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Go process exited with code ${code}`));
    });
  });
}

// Re-export for tests
export { waitForPort as _waitForPort };
