import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Readable } from "node:stream";
import { http, HttpResponse } from "msw";
import { useMockHttpServer } from "@iterate-com/mock-http-proxy";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";

function firstNonEmpty(values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (trimmed) return trimmed;
  }
  return "";
}

function gitOutput(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function resolveDockerHostSync() {
  return {
    repoRoot: gitOutput(["rev-parse", "--show-toplevel"]),
    gitDir: gitOutput(["rev-parse", "--path-format=absolute", "--git-dir"]),
    commonDir: gitOutput(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  };
}

function dockerOutput(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

async function curlHostProbe(params: {
  baseUrl: string;
  host: string;
  path?: string;
  timeoutSeconds?: number;
}): Promise<string> {
  const path = params.path ?? "/";
  const timeoutSeconds = params.timeoutSeconds ?? 8;
  const url = new URL(path, params.baseUrl).toString();
  return execFileSync(
    "curl",
    [
      "-sS",
      "-i",
      "--max-time",
      String(timeoutSeconds),
      "-H",
      "Connection: Upgrade",
      "-H",
      "Upgrade: websocket",
      "-H",
      "Sec-WebSocket-Version: 13",
      "-H",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "-H",
      `Host: ${params.host}`,
      url,
    ],
    { encoding: "utf8" },
  );
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function normalizeContainerName(name: string | undefined): string {
  const raw = (name ?? "").trim();
  if (!raw) return "";
  return raw.startsWith("/") ? raw.slice(1) : raw;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveFrpcBinary(): string {
  const explicit = process.env.JONASLAND_E2E_FRPC_BIN?.trim();
  if (explicit) return explicit;
  const discovered = execFileSync("sh", ["-lc", "command -v frpc"], { encoding: "utf8" }).trim();
  if (!discovered) {
    throw new Error("frpc not found; set JONASLAND_E2E_FRPC_BIN or install frpc");
  }
  return discovered;
}

async function startFrpc(params: {
  controlServerHost: string;
  controlServerPort: number;
  localTargetHost: string;
  localTargetPort: number;
}): Promise<{
  waitUntilConnected: () => Promise<void>;
  logs: () => string;
  stop: () => Promise<void>;
}> {
  const frpcBin = resolveFrpcBinary();
  const tempDir = await mkdtemp(join(tmpdir(), "frp-docker-repro-"));
  const configPath = join(tempDir, "frpc.toml");
  const config = [
    `serverAddr = "${params.controlServerHost}"`,
    `serverPort = ${String(params.controlServerPort)}`,
    'transport.protocol = "websocket"',
    "loginFailExit = false",
    "",
    "[[proxies]]",
    'name = "vitest-mock-egress"',
    'type = "tcp"',
    `localIP = "${params.localTargetHost}"`,
    `localPort = ${String(params.localTargetPort)}`,
    "remotePort = 27180",
    "",
  ].join("\n");
  await writeFile(configPath, config, "utf8");

  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(frpcBin, ["-c", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines: string[] = [];
  child.stdout.on("data", (chunk) => lines.push(String(chunk)));
  child.stderr.on("data", (chunk) => lines.push(String(chunk)));
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
    lines.push(`[frpc spawn error] ${error.message}`);
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (!child.killed) child.kill("SIGTERM");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      await sleep(100);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(tempDir, { recursive: true, force: true });
  };

  const waitUntilConnected = async (): Promise<void> => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const joined = lines.join("");
      if (spawnError) {
        throw new Error(`frpc spawn failed: ${spawnError.message}\n${joined}`);
      }
      if (child.exitCode !== null) {
        throw new Error(`frpc exited early code=${String(child.exitCode)}\n${joined}`);
      }
      if (
        /start proxy success/i.test(joined) ||
        /proxy added successfully/i.test(joined) ||
        /login to server success/i.test(joined)
      ) {
        return;
      }
      await sleep(150);
    }
    throw new Error(`timed out waiting for frpc connection\n${lines.join("")}`);
  };

  return {
    waitUntilConnected,
    logs: () => lines.join(""),
    stop,
  };
}

async function ensureExternalProxyConfigured(params: {
  deployment: DockerDeployment;
  proxyUrl: string;
}): Promise<void> {
  await params.deployment.setEnvVars({
    ITERATE_EXTERNAL_EGRESS_PROXY: params.proxyUrl,
  });
  await params.deployment.pidnap.processes.updateConfig({
    processSlug: "egress-proxy",
    definition: {
      command: "/home/iterate/src/github.com/iterate/iterate/packages/pidnap/node_modules/.bin/tsx",
      args: ["/home/iterate/src/github.com/iterate/iterate/services/egress-service/src/server.ts"],
      env: {
        EGRESS_PROXY_PORT: "19000",
      },
    },
    options: { restartPolicy: "always" },
    envOptions: { reloadDelay: 500 },
    healthCheck: {
      url: "http://127.0.0.1:19000/__iterate/health",
      intervalMs: 2_000,
    },
  });

  const runtime = await params.deployment.exec([
    "sh",
    "-lc",
    'for i in $(seq 1 45); do out=$(curl -fsS http://127.0.0.1:19000/api/runtime 2>/dev/null || true); echo "$out" | rg -q \'"externalProxyConfigured":true\' && { echo "$out"; exit 0; }; sleep 1; done; exit 1',
  ]);
  if (runtime.exitCode !== 0) {
    throw new Error(`egress-proxy did not become externally configured:\n${runtime.output}`);
  }
}

async function main(): Promise<void> {
  const dockerImage = firstNonEmpty([
    process.env.E2E_DOCKER_IMAGE_REF,
    process.env.JONASLAND_SANDBOX_IMAGE,
  ]);
  if (!dockerImage) {
    throw new Error("set E2E_DOCKER_IMAGE_REF or JONASLAND_SANDBOX_IMAGE");
  }

  const dockerHostSync = resolveDockerHostSync();
  console.log(`[frp-repro] docker image=${dockerImage}`);
  console.log(
    `[frp-repro] host-sync repoRoot=${dockerHostSync.repoRoot} gitDir=${dockerHostSync.gitDir} commonDir=${dockerHostSync.commonDir}`,
  );

  await using deployment = await DockerDeployment.create({
    dockerImage,
    name: `frp-repro-${randomUUID().slice(0, 8)}`,
    dockerHostSync,
    signal: AbortSignal.timeout(180_000),
  });

  await deployment.waitUntilAlive({ signal: AbortSignal.timeout(180_000) });
  const inspect = await deployment.containerInspect();
  const containerId = inspect.Id ?? "";
  const containerName = normalizeContainerName(inspect.Name);
  if (!containerId) throw new Error("missing container id from inspect");
  if (!containerName) throw new Error("missing container name from inspect");
  console.log(`[frp-repro] deployment baseUrl=${deployment.baseUrl}`);
  console.log(`[frp-repro] containerId=${containerId}`);
  console.log(`[frp-repro] containerName=${containerName}`);
  console.log(
    `[frp-repro] docker ps:\n${dockerOutput(["ps", "--filter", `id=${containerId}`, "--format", "table {{.ID}}\t{{.Status}}\t{{.Ports}}"])}`,
  );

  const publicBaseHost = `${containerName}.orb.local`;
  const frpControlHost = `frp.${publicBaseHost}`;
  const runId = randomUUID().slice(0, 8);
  const artifactsDir = join(process.cwd(), "artifacts", "frp-playground");
  const harPath = join(artifactsDir, `docker-frp-egress-${runId}.har`);
  await mkdir(artifactsDir, { recursive: true });
  console.log(`[frp-repro] setting ITERATE_PUBLIC_BASE_HOST=${publicBaseHost}`);
  await deployment.setEnvVars({
    ITERATE_PUBLIC_BASE_HOST: publicBaseHost,
    ITERATE_PUBLIC_BASE_HOST_TYPE: "subdomain",
  });
  console.log(`[frp-repro] HAR output path=${harPath}`);

  await using mockServer = await useMockHttpServer({
    onUnhandledRequest: "bypass",
    recorder: {
      enabled: true,
      harPath,
    },
  });
  mockServer.use(
    http.all("*", async ({ request }) => {
      const body = await request.text();
      return HttpResponse.json(
        {
          ok: true,
          method: request.method,
          url: request.url,
          body,
        },
        {
          headers: {
            "x-har-mock": "1",
          },
        },
      );
    }),
  );
  console.log(`[frp-repro] mock proxy listening on 127.0.0.1:${String(mockServer.port)}`);

  const routes = await deployment.registry.routes.list({});
  console.log(
    `[frp-repro] registry routes (${String(routes.total)}):\n${routes.routes.map((r) => `- ${r.host} -> ${r.target}`).join("\n")}`,
  );

  const probes: Array<{ host: string; path: string }> = [
    { host: "frp.iterate.localhost", path: "/" },
    { host: "frp.iterate.localhost", path: "/~!frp" },
    { host: frpControlHost, path: "/" },
    { host: frpControlHost, path: "/~!frp" },
    { host: "127.0.0.1", path: "/" },
    { host: "localhost", path: "/" },
  ];
  for (const probe of probes) {
    try {
      const output = await curlHostProbe({
        baseUrl: deployment.baseUrl,
        host: probe.host,
        path: probe.path,
      });
      const firstLines = output.split("\n").slice(0, 12).join("\n");
      console.log(`[frp-repro] probe host=${probe.host} path=${probe.path}\n${firstLines}\n`);
    } catch (error) {
      console.log(
        `[frp-repro] probe host=${probe.host} path=${probe.path} failed: ${errorDetails(error)}`,
      );
    }
  }

  console.log("[frp-repro] tailing caddy/frp logs before frpc attempt");
  const processLogs = await deployment.exec([
    "sh",
    "-lc",
    'for f in /home/iterate/src/github.com/iterate/iterate/logs/process/caddy.log /home/iterate/src/github.com/iterate/iterate/logs/process/frp.log; do echo "===== $f ====="; tail -n 120 "$f" 2>/dev/null || true; done',
  ]);
  console.log(processLogs.output);

  const controlPort = Number.parseInt(process.env.JONASLAND_E2E_FRP_CONTROL_PORT ?? "80", 10);
  if (!Number.isFinite(controlPort) || controlPort <= 0) {
    throw new Error(`invalid frp control port: ${String(controlPort)}`);
  }

  let frpc:
    | {
        waitUntilConnected: () => Promise<void>;
        logs: () => string;
        stop: () => Promise<void>;
      }
    | undefined;
  try {
    console.log(`[frp-repro] starting frpc -> ${frpControlHost}:${String(controlPort)} (ws)`);
    frpc = await startFrpc({
      controlServerHost: frpControlHost,
      controlServerPort: controlPort,
      localTargetHost: "127.0.0.1",
      localTargetPort: mockServer.port,
    });
    await frpc.waitUntilConnected();
    console.log("[frp-repro] frpc connected");

    await ensureExternalProxyConfigured({
      deployment,
      proxyUrl: "http://127.0.0.1:27180",
    });

    const requestPath = `/playground-har-egress/${runId}`;
    const requestBody = JSON.stringify({ from: "playground-frp" });
    const dataProbe = await deployment.exec([
      "curl",
      "-sS",
      "--max-time",
      "8",
      "-i",
      `http://127.0.0.1:27180${requestPath}`,
    ]);
    console.log(
      `[frp-repro] data port probe exit=${String(dataProbe.exitCode)}\n${dataProbe.output}`,
    );

    const egressProbe = await deployment.exec([
      "curl",
      "-k",
      "-sS",
      "-i",
      "--max-time",
      "30",
      "-H",
      "content-type: application/json",
      "--data",
      requestBody,
      `https://example.com${requestPath}`,
    ]);
    console.log(
      `[frp-repro] egress probe exit=${String(egressProbe.exitCode)}\n${egressProbe.output.slice(0, 800)}`,
    );
    if (!egressProbe.output.toLowerCase().includes("x-iterate-egress-mode: external-proxy")) {
      throw new Error(`egress probe did not go through external proxy:\n${egressProbe.output}`);
    }
    if (!egressProbe.output.toLowerCase().includes("x-har-mock: 1")) {
      throw new Error(`egress probe did not hit mock proxy:\n${egressProbe.output}`);
    }

    await mockServer.writeHar(harPath);
    const har = JSON.parse(await readFile(harPath, "utf8")) as {
      log?: { entries?: Array<{ request?: { url?: string; method?: string } }> };
    };
    const entries = har.log?.entries ?? [];
    const matched = entries.find(
      (entry) =>
        entry.request?.url?.includes(requestPath) &&
        entry.request?.url?.startsWith("https://example.com/") &&
        entry.request?.method === "POST",
    );
    if (!matched) {
      throw new Error(
        `HAR did not contain expected POST egress entry for ${requestPath}; entries=${entries.length}`,
      );
    }
    console.log(
      `[frp-repro] HAR recorded: method=${matched.request?.method ?? "n/a"} url=${matched.request?.url ?? "n/a"}`,
    );
    console.log(`[frp-repro] HAR file saved at ${harPath}`);
  } catch (error) {
    console.log(`[frp-repro] frpc repro failed:\n${errorDetails(error)}`);
    if (frpc) {
      console.log(`[frp-repro] frpc logs:\n${frpc.logs()}`);
    }
  } finally {
    if (frpc) await frpc.stop().catch(() => {});
  }

  console.log("[frp-repro] docker logs tail");
  console.log(dockerOutput(["logs", "--tail", "160", containerId]));

  if (process.env.FRP_REPRO_WAIT === "true") {
    console.log("[frp-repro] press Enter to teardown");
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      await rl.question("");
    } finally {
      rl.close();
    }
  }
}

main().catch((error) => {
  console.error(`[frp-repro] fatal: ${errorDetails(error)}`);
  process.exitCode = 1;
});
