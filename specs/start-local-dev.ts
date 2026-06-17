import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { parseArgs } from "node:util";
import { createAuthContractClient } from "@iterate-com/auth-contract";
import { OS_APP_ROOT, REPO_ROOT, waitForLocalOsBaseUrl } from "./test-support/local-dev.ts";

const { values } = parseArgs({
  options: {
    "ready-port": { type: "string", default: "17604" },
  },
});

const readyPort = Number(values["ready-port"]);
if (!Number.isInteger(readyPort) || readyPort <= 0) {
  throw new Error(`Invalid --ready-port: ${String(values["ready-port"])}`);
}

const localAuthServiceToken =
  process.env.OS_PLAYWRIGHT_LOCAL_AUTH_SERVICE_TOKEN || "os-playwright-local-auth-service-token";
const localAlchemyStage = "dev_playwright";

const children: ChildProcess[] = [];
let server: Server | undefined;

if (!process.env.OS_PLAYWRIGHT_BASE_URL) {
  startDevProcess("auth", {
    args: [
      "run",
      "--preserve-env=ALCHEMY_STAGE,APP_CONFIG_ITERATE_AUTH__ISSUER,SERVICE_AUTH_TOKEN,VITE_AUTH_APP_ORIGIN,VITE_PUBLIC_URL",
      "--",
      "pnpm",
      "dev:local",
    ],
    cwd: `${REPO_ROOT}/apps/auth`,
    env: {
      ...process.env,
      ALCHEMY_STAGE: localAlchemyStage,
      APP_CONFIG_ITERATE_AUTH__ISSUER: "http://localhost:7101/api/auth",
      SERVICE_AUTH_TOKEN: localAuthServiceToken,
      VITE_AUTH_APP_ORIGIN: "http://localhost:7101",
      VITE_PUBLIC_URL: "http://localhost:7101",
    },
  });
  await waitForLocalAuthService(localAuthServiceToken);
  startDevProcess("os", {
    args: [
      "run",
      "--preserve-env=ALCHEMY_STAGE,APP_CONFIG_ITERATE_AUTH__ISSUER,APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN,DEV_TUNNEL,ITERATE_AUTH_SERVICE_TOKEN,ITERATE_OAUTH_ISSUER",
      "--",
      "pnpm",
      "dev:local",
    ],
    cwd: OS_APP_ROOT,
    env: {
      ...process.env,
      ALCHEMY_STAGE: localAlchemyStage,
      APP_CONFIG_ITERATE_AUTH__ISSUER: "http://localhost:7101/api/auth",
      APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN: localAuthServiceToken,
      ITERATE_AUTH_SERVICE_TOKEN: localAuthServiceToken,
      ITERATE_OAUTH_ISSUER: "http://localhost:7101/api/auth",
    },
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
    for (const child of children) {
      child.kill(signal);
    }
    if (children.length === 0) process.exit(exitCodeForSignal(signal) ?? 0);
  });
}

function startDevProcess(
  label: string,
  input: { args: string[]; cwd: string; env: NodeJS.ProcessEnv },
) {
  const child = spawn("doppler", input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout?.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  child.once("exit", (code, signal) => {
    process.exit(code ?? exitCodeForSignal(signal) ?? 1);
  });
}

async function waitForLocalAuthService(serviceToken: string) {
  const authClient = createAuthContractClient({
    baseUrl: "http://localhost:7101",
    serviceToken,
  });
  const deadline = Date.now() + 120_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await authClient.internal.project.mintProjectId();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error(`Timed out waiting for local auth service: ${String(lastError)}`);
}

function exitCodeForSignal(signal: NodeJS.Signals | null) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return undefined;
}
