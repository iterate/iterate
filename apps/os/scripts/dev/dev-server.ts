import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { os } from "@orpc/server";
import { z } from "zod";

import {
  killLocalDevServer,
  type KillLocalDevServerResult,
} from "@iterate-com/shared/alchemy/local-dev-server";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_DIR, "../..");
const NoInput = z.object({});

export const devServerScripts = os.router({
  kill: os
    .input(NoInput)
    .meta({
      description:
        "Stop the recorded local OS dev server and keep .alchemy/dev-server.json for port reuse.",
    })
    .handler(async () => {
      const result = await killRecordedDevServer();
      printKillResult(result);
      return null;
    }),
  restart: os
    .input(NoInput)
    .meta({
      description:
        "Stop the recorded local OS dev server, then start pnpm dev using the remembered port when free.",
    })
    .handler(async () => {
      const result = await killRecordedDevServer();
      printKillResult(result);
      runPnpmDev();
      return null;
    }),
});

async function killRecordedDevServer() {
  return await killLocalDevServer({
    appDir: APP_ROOT,
    forceAfterTimeout: true,
  });
}

function printKillResult(result: KillLocalDevServerResult) {
  switch (result.status) {
    case "missing":
      console.log(`No local dev server discovery file at ${result.path}.`);
      break;
    case "stale":
      console.log(
        `No running local dev server for recorded pid ${result.info.pid}; keeping ${result.path} so port ${result.info.port} can be reused.`,
      );
      break;
    case "killed":
      console.log(
        `Stopped local dev server pid ${result.info.pid} (${result.info.baseUrl}); keeping ${result.path} so port ${result.info.port} can be reused.`,
      );
      break;
    case "force-killed":
      console.log(
        `Force-stopped local dev server pid ${result.info.pid} (${result.info.baseUrl}); keeping ${result.path} so port ${result.info.port} can be reused.`,
      );
      break;
  }
}

function runPnpmDev(): never {
  const result = spawnSync("pnpm", ["dev"], {
    cwd: APP_ROOT,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
  }

  process.exit(result.status ?? 1);
}
