import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { ProjectDeployment } from "./project-deployment.ts";

const FRP_CONTROL_BIND_PORT = 27000;
const FRP_DATA_REMOTE_PORT = 27180;
const CONNECT_TIMEOUT_MS = 45_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeRunId(input?: string): string {
  const candidate = (input ?? randomUUID().slice(0, 8)).trim().toLowerCase();
  const safe = candidate
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return safe || randomUUID().slice(0, 8);
}

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function configureFlyFrps(params: {
  deployment: ProjectDeployment;
  processSlug: string;
  token: string;
}): Promise<void> {
  const configPath = `/tmp/${params.processSlug}.frps.toml`;
  const config = [
    `bindAddr = ${tomlString("0.0.0.0")}`,
    `bindPort = ${String(FRP_CONTROL_BIND_PORT)}`,
    `auth.token = ${tomlString(params.token)}`,
    "",
  ].join("\n");

  const writeConfig = await params.deployment.exec([
    "sh",
    "-ec",
    `cat > ${configPath} <<'EOF_CFG'\n${config}\nEOF_CFG`,
  ]);
  if (writeConfig.exitCode !== 0) {
    throw new Error(`failed writing frps config:\n${writeConfig.output}`);
  }

  const pidFile = `/tmp/${params.processSlug}.frps.pid`;
  const logFile = `/tmp/${params.processSlug}.frps.log`;
  const startScript = [
    "set -euo pipefail",
    "FRPS_BIN=/usr/local/bin/frps",
    'if [ ! -x "$FRPS_BIN" ]; then echo "frps binary missing at /usr/local/bin/frps" >&2; exit 1; fi',
    `PID_FILE=${shellSingleQuote(pidFile)}`,
    `LOG_FILE=${shellSingleQuote(logFile)}`,
    'if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then kill "$(cat "$PID_FILE")" || true; fi',
    `nohup "$FRPS_BIN" -c ${shellSingleQuote(configPath)} > "$LOG_FILE" 2>&1 &`,
    'echo $! > "$PID_FILE"',
  ].join("\n");

  const start = await params.deployment.exec(["bash", "-lc", startScript]);
  if (start.exitCode !== 0) {
    throw new Error(`failed to start frps:\n${start.output}`);
  }

  const waitPort = await params.deployment.exec([
    "bash",
    "-lc",
    `for i in $(seq 1 120); do (echo > /dev/tcp/127.0.0.1/${String(FRP_CONTROL_BIND_PORT)}) >/dev/null 2>&1 && exit 0; sleep 0.5; done; exit 1`,
  ]);
  if (waitPort.exitCode !== 0) {
    const logs = await params.deployment
      .exec(["bash", "-lc", `tail -n 200 ${shellSingleQuote(logFile)} || true`])
      .catch(() => ({ exitCode: 1, output: "" }));
    throw new Error(`frps did not open port ${String(FRP_CONTROL_BIND_PORT)}:\n${logs.output}`);
  }
}

async function stopFlyFrpsBestEffort(params: {
  deployment: ProjectDeployment;
  processSlug: string;
}): Promise<void> {
  const pidFile = `/tmp/${params.processSlug}.frps.pid`;
  await params.deployment
    .exec([
      "bash",
      "-lc",
      `if [ -f ${shellSingleQuote(pidFile)} ]; then kill "$(cat ${shellSingleQuote(pidFile)})" 2>/dev/null || true; rm -f ${shellSingleQuote(pidFile)}; fi; pkill -f ${shellSingleQuote(`${params.processSlug}.frps.toml`)} 2>/dev/null || true`,
    ])
    .catch(() => {});
}

async function readFlyFrpsLogsBestEffort(params: {
  deployment: ProjectDeployment;
  processSlug: string;
}): Promise<string> {
  const logFile = `/tmp/${params.processSlug}.frps.log`;
  const result = await params.deployment
    .exec(["bash", "-lc", `tail -n 200 ${shellSingleQuote(logFile)} || true`])
    .catch(() => ({ exitCode: 1, output: "" }));
  return result.output.trim();
}

async function startFrpc(params: {
  controlServerHost: string;
  controlServerPort: number;
  controlTransportProtocol: "websocket" | "wss";
  token: string;
  localTargetPort: number;
  frpcBin?: string;
}): Promise<{
  logs: () => string;
  stop: () => Promise<void>;
  waitUntilConnected: () => Promise<void>;
}> {
  const frpcBin = params.frpcBin ?? process.env.JONASLAND_E2E_FRPC_BIN ?? "frpc";
  const tmpDir = await mkdtemp(join(tmpdir(), "jonasland-frpc-client-"));
  const configPath = join(tmpDir, "frpc.toml");

  const config = [
    `serverAddr = ${tomlString(params.controlServerHost)}`,
    `serverPort = ${String(params.controlServerPort)}`,
    `transport.protocol = ${tomlString(params.controlTransportProtocol)}`,
    `auth.token = ${tomlString(params.token)}`,
    "",
    "[[proxies]]",
    `name = ${tomlString("vitest-mock-egress")}`,
    `type = ${tomlString("tcp")}`,
    `localIP = ${tomlString("127.0.0.1")}`,
    `localPort = ${String(params.localTargetPort)}`,
    `remotePort = ${String(FRP_DATA_REMOTE_PORT)}`,
    "",
  ].join("\n");

  await writeFile(configPath, config, "utf-8");

  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(frpcBin, ["-c", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output: string[] = [];
  child.stdout.on("data", (chunk) => {
    output.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    output.push(String(chunk));
  });

  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
    output.push(`[frpc spawn error] ${error.message}\n`);
  });

  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;

    if (!child.killed) {
      child.kill("SIGTERM");
    }

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      await sleep(50);
    }

    if (child.exitCode === null && child.signalCode === null && !child.killed) {
      child.kill("SIGKILL");
    }

    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };

  const waitUntilConnected = async () => {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (spawnError) {
        throw new Error(`failed to start frpc: ${spawnError.message}\n${output.join("")}`);
      }
      if (child.exitCode !== null) {
        throw new Error(
          `frpc exited early with code ${String(child.exitCode)}:\n${output.join("")}`,
        );
      }

      const logs = output.join("");
      if (
        /start proxy success/i.test(logs) ||
        /proxy added successfully/i.test(logs) ||
        /login to server success/i.test(logs)
      ) {
        return;
      }

      await sleep(100);
    }

    await stop();
    throw new Error(`timed out waiting for frpc to connect:\n${output.join("")}`);
  };

  return {
    logs: () => output.join(""),
    stop,
    waitUntilConnected,
  };
}

export interface FlyFrpEgressBridge extends AsyncDisposable {
  runId: string;
  dataProxyUrl: string;
  clientLogs(): string;
  stop(): Promise<void>;
}

export async function startFlyFrpEgressBridge(params: {
  deployment: ProjectDeployment;
  localTargetPort: number;
  frpcBin?: string;
  runId?: string;
}): Promise<FlyFrpEgressBridge> {
  let step = "init";
  let runId = "";
  let processSlug = "";
  let controlServerHost = "";
  let controlServerPort = 443;
  let controlTransportProtocol: "websocket" | "wss" = "wss";
  let dataProxyUrl = "";

  try {
    step = "compute-run-context";
    runId = sanitizeRunId(params.runId);
    processSlug = `frps-${runId}`;
    const token = randomUUID();
    const ingressUrl = new URL(await params.deployment.ingressUrl());
    controlServerHost = ingressUrl.hostname;
    controlServerPort =
      ingressUrl.port.length > 0
        ? Number.parseInt(ingressUrl.port, 10)
        : ingressUrl.protocol === "https:"
          ? 443
          : 80;
    controlTransportProtocol = ingressUrl.protocol === "https:" ? "wss" : "websocket";
    dataProxyUrl = `http://127.0.0.1:${String(FRP_DATA_REMOTE_PORT)}`;

    step = "configure-fly-frps";
    await configureFlyFrps({
      deployment: params.deployment,
      processSlug,
      token,
    });

    step = "start-frpc";
    const frpc = await startFrpc({
      controlServerHost,
      controlServerPort,
      controlTransportProtocol,
      token,
      localTargetPort: params.localTargetPort,
      frpcBin: params.frpcBin,
    });

    try {
      step = "wait-frpc-connected";
      await frpc.waitUntilConnected();
    } catch (error) {
      const frpsLogs = await readFlyFrpsLogsBestEffort({
        deployment: params.deployment,
        processSlug,
      });
      await frpc.stop().catch(() => {});
      await stopFlyFrpsBestEffort({
        deployment: params.deployment,
        processSlug,
      });
      throw new Error(
        `frpc failed to connect (controlServerHost=${controlServerHost}, dataProxyUrl=${dataProxyUrl})\nfrps logs:\n${frpsLogs || "(empty)"}`,
        { cause: error },
      );
    }

    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;

      await frpc.stop().catch(() => {});
      await stopFlyFrpsBestEffort({
        deployment: params.deployment,
        processSlug,
      });
    };

    return {
      runId,
      dataProxyUrl,
      clientLogs: () => frpc.logs(),
      stop,
      async [Symbol.asyncDispose]() {
        await stop();
      },
    };
  } catch (error) {
    throw new Error(
      `startFlyFrpEgressBridge failed during: ${step} (runId=${runId || "n/a"}, processSlug=${processSlug || "n/a"}, controlServerHost=${controlServerHost || "n/a"}, dataProxyUrl=${dataProxyUrl || "n/a"})`,
      { cause: error },
    );
  }
}
