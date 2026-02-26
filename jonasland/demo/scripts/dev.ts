#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const defaultUiPort = Number.parseInt(process.env.JONASLAND_DEMO_UI_PORT ?? "5173", 10);
const defaultApiPort = Number.parseInt(process.env.JONASLAND_DEMO_API_PORT ?? "19099", 10);

async function findAvailablePort(startPort: number): Promise<number> {
  let port = startPort;

  while (true) {
    const available = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", () => {
        resolve(false);
      });
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });

    if (available) {
      return port;
    }

    port += 1;
  }
}

async function main(): Promise<void> {
  const uiPort = await findAvailablePort(defaultUiPort);
  const apiPort = await findAvailablePort(defaultApiPort);
  const apiBase = `http://127.0.0.1:${String(apiPort)}`;

  process.stdout.write(`[jonasland-demo] ui port: ${String(uiPort)}\n`);
  process.stdout.write(`[jonasland-demo] api port: ${String(apiPort)}\n`);
  process.stdout.write(`[jonasland-demo] api base: ${apiBase}\n`);

  const children = [
    spawn(command, ["run", "dev:api"], {
      stdio: "inherit",
      env: {
        ...process.env,
        JONASLAND_DEMO_API_PORT: String(apiPort),
      },
    }),
    spawn(command, ["run", "dev:ui", "--", "--host", "127.0.0.1", "--port", String(uiPort)], {
      stdio: "inherit",
      env: {
        ...process.env,
        VITE_JONASLAND_DEMO_API_BASE: apiBase,
      },
    }),
  ];

  let shuttingDown = false;

  function shutdown(exitCode = 0): void {
    if (shuttingDown) return;
    shuttingDown = true;

    for (const child of children) {
      child.kill("SIGTERM");
    }

    setTimeout(() => {
      for (const child of children) {
        child.kill("SIGKILL");
      }
      process.exit(exitCode);
    }, 2_000).unref();
  }

  for (const child of children) {
    child.on("exit", (code) => {
      shutdown(code ?? 0);
    });
  }

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

void main();
