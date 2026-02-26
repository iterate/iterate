import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { CfProxyWorkerClient } from "./cf-proxy-worker-client.ts";
import type { ProjectDeployment } from "./project-deployment.ts";

const FRP_VERSION = "0.65.0";
const FRP_CONTROL_HOST_HEADER = "frp-control.iterate.localhost";
const FRP_DATA_HOST_SUFFIX = "frp-egress.iterate.localhost";
const FRP_CONTROL_BIND_PORT = 27000;
const FRP_DATA_VHOST_PORT = 27080;
const ROUTE_TTL_SECONDS = 20 * 60;
const CONNECT_TIMEOUT_MS = 45_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRouteDomainSuffix(input: string): string {
  const normalized = input.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized.includes("/") || normalized.includes(":")) {
    throw new Error(`Invalid cf-proxy-worker route domain: ${input}`);
  }
  return normalized;
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

function normalizeTargetBaseUrl(input: string): string {
  const parsed = new URL(input);
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

async function deleteRouteBestEffort(client: CfProxyWorkerClient, route: string): Promise<void> {
  await client.deleteRoute({ route }).catch(() => {});
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
    `vhostHTTPPort = ${String(FRP_DATA_VHOST_PORT)}`,
    "",
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

  const bootstrapScript = [
    "set -euo pipefail",
    `FRP_VERSION=${shellSingleQuote(FRP_VERSION)}`,
    "ARCH=$(uname -m)",
    'case "$ARCH" in',
    "  x86_64|amd64) FRP_ARCH=amd64 ;;",
    "  aarch64|arm64) FRP_ARCH=arm64 ;;",
    '  *) echo "unsupported frp arch: $ARCH" >&2; exit 1 ;;',
    "esac",
    "ROOT=/tmp/iterate-frp",
    'mkdir -p "$ROOT/bin" "$ROOT/cache"',
    'FRPS="$ROOT/bin/frps"',
    'if [ ! -x "$FRPS" ]; then',
    '  ASSET="frp_${FRP_VERSION}_linux_${FRP_ARCH}.tar.gz"',
    '  URL="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${ASSET}"',
    '  TAR="$ROOT/cache/$ASSET"',
    '  EXTRACT="$ROOT/cache/frp_${FRP_VERSION}_linux_${FRP_ARCH}"',
    '  rm -rf "$EXTRACT"',
    '  curl -fsSL "$URL" -o "$TAR"',
    '  tar -xzf "$TAR" -C "$ROOT/cache"',
    '  cp "$EXTRACT/frps" "$FRPS"',
    '  chmod +x "$FRPS"',
    "fi",
    `exec \"$FRPS\" -c ${shellSingleQuote(configPath)}`,
  ].join("\n");

  const updated = await params.deployment.pidnap.processes.updateConfig({
    processSlug: params.processSlug,
    definition: {
      command: "/bin/sh",
      args: ["-ec", bootstrapScript],
      env: {
        FRP_VERSION,
      },
    },
    options: {
      restartPolicy: "always",
    },
    envOptions: {
      reloadDelay: false,
    },
    tags: ["e2e", "frp"],
  });

  if (updated.state !== "running") {
    await params.deployment.pidnap.processes.start({ target: params.processSlug });
  }

  await params.deployment.waitForPidnapProcessRunning({
    target: params.processSlug,
    timeoutMs: 60_000,
  });
}

async function startFrpc(params: {
  controlRouteHost: string;
  token: string;
  dataHost: string;
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
    `serverAddr = ${tomlString(params.controlRouteHost)}`,
    `serverPort = ${String(443)}`,
    `transport.protocol = ${tomlString("wss")}`,
    `auth.token = ${tomlString(params.token)}`,
    "",
    "[[proxies]]",
    `name = ${tomlString("vitest-mock-egress")}`,
    `type = ${tomlString("http")}`,
    `localIP = ${tomlString("127.0.0.1")}`,
    `localPort = ${String(params.localTargetPort)}`,
    `customDomains = [${tomlString(params.dataHost)}]`,
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
  cfProxyWorkerClient: CfProxyWorkerClient;
  cfProxyWorkerRouteDomain: string;
  localTargetPort: number;
  frpcBin?: string;
  runId?: string;
}): Promise<FlyFrpEgressBridge> {
  const runId = sanitizeRunId(params.runId);
  const processSlug = `frps-${runId}`;
  const token = randomUUID();
  const routeDomain = normalizeRouteDomainSuffix(params.cfProxyWorkerRouteDomain);
  const targetBaseUrl = normalizeTargetBaseUrl(await params.deployment.ingressUrl());

  const controlRouteHost = `frpctl-${runId}.${routeDomain}`;
  const dataRouteHost = `frpdata-${runId}.${routeDomain}`;
  const dataHost = `frp-${runId}.${FRP_DATA_HOST_SUFFIX}`;

  await configureFlyFrps({
    deployment: params.deployment,
    processSlug,
    token,
  });

  await params.cfProxyWorkerClient.setRoute({
    route: controlRouteHost,
    target: targetBaseUrl,
    headers: {
      host: FRP_CONTROL_HOST_HEADER,
    },
    metadata: {
      source: "jonasland-e2e-frp",
      kind: "frp-control",
      runId,
    },
    ttlSeconds: ROUTE_TTL_SECONDS,
  });

  try {
    await params.cfProxyWorkerClient.setRoute({
      route: dataRouteHost,
      target: targetBaseUrl,
      headers: {
        host: dataHost,
      },
      metadata: {
        source: "jonasland-e2e-frp",
        kind: "frp-data",
        runId,
      },
      ttlSeconds: ROUTE_TTL_SECONDS,
    });
  } catch (error) {
    await deleteRouteBestEffort(params.cfProxyWorkerClient, controlRouteHost);
    throw error;
  }

  const frpc = await startFrpc({
    controlRouteHost,
    token,
    dataHost,
    localTargetPort: params.localTargetPort,
    frpcBin: params.frpcBin,
  });

  try {
    await frpc.waitUntilConnected();
  } catch (error) {
    await frpc.stop().catch(() => {});
    await deleteRouteBestEffort(params.cfProxyWorkerClient, dataRouteHost);
    await deleteRouteBestEffort(params.cfProxyWorkerClient, controlRouteHost);
    await params.deployment.pidnap.processes.delete({ processSlug }).catch(() => {});
    throw error;
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;

    await frpc.stop().catch(() => {});
    await deleteRouteBestEffort(params.cfProxyWorkerClient, dataRouteHost);
    await deleteRouteBestEffort(params.cfProxyWorkerClient, controlRouteHost);
    await params.deployment.pidnap.processes.delete({ processSlug }).catch(() => {});
  };

  return {
    runId,
    dataProxyUrl: `https://${dataRouteHost}`,
    clientLogs: () => frpc.logs(),
    stop,
    async [Symbol.asyncDispose]() {
      await stop();
    },
  };
}
