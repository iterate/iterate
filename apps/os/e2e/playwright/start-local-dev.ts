import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { parseArgs } from "node:util";
import { readLocalDevServerInfo } from "@iterate-com/shared/alchemy/local-dev-server";
import { OS_APP_ROOT, waitForLocalOsBaseUrl } from "./test-support/local-dev.ts";

const { values } = parseArgs({
  options: {
    "ready-port": { type: "string", default: "17604" },
  },
});

const readyPort = Number(values["ready-port"]);
if (!Number.isInteger(readyPort) || readyPort <= 0) {
  throw new Error(`Invalid --ready-port: ${String(values["ready-port"])}`);
}

let child: ChildProcess | undefined;
let server: Server | undefined;

const existing = readLocalDevServerInfo(OS_APP_ROOT, { requireLive: true });
if (!existing) {
  child = spawn("pnpm", ["dev"], {
    cwd: OS_APP_ROOT,
    env: {
      ...process.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  child.once("exit", (code, signal) => {
    if (!server?.listening) {
      process.exit(code ?? exitCodeForSignal(signal) ?? 1);
    }
  });
}

const baseUrl = await waitForLocalOsBaseUrl({ timeoutMs: 180_000 });
server = createServer((request, response) => {
  if (request.url !== "/ready") {
    response.writeHead(404).end();
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ ok: true, baseUrl }));
});

await new Promise<void>((resolve, reject) => {
  server!.once("error", reject);
  server!.listen(readyPort, "127.0.0.1", () => resolve());
});

console.log(`OS Playwright ready at http://127.0.0.1:${readyPort}/ready for ${baseUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server?.close();
    child?.kill(signal);
    if (!child) process.exit(exitCodeForSignal(signal) ?? 0);
  });
}

function exitCodeForSignal(signal: NodeJS.Signals | null) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return undefined;
}
