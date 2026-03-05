import { randomUUID } from "node:crypto";
import { access, chmod, copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";

const FRP_DATA_REMOTE_PORT = 27180;
const FRP_VERSION = "0.65.0";
const CONNECT_TIMEOUT_MS = 45_000;
const DEFAULT_INGRESS_PROXY_BASE_URL = "https://ingress.iterate.com";
const DEFAULT_INGRESS_PROXY_DOMAIN = "ingress.iterate.com";

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

function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", `command -v ${shellSingleQuote(command)} >/dev/null 2>&1`], {
      stdio: "ignore",
    });
    child.once("exit", (code) => {
      resolve(code === 0);
    });
    child.once("error", () => {
      resolve(false);
    });
  });
}

function resolveFrpDownloadTarget(): { os: string; arch: string } {
  const os = platform();
  const cpu = arch();

  const frpOs = os === "darwin" ? "darwin" : os === "linux" ? "linux" : null;
  const frpArch = cpu === "x64" ? "amd64" : cpu === "arm64" ? "arm64" : null;

  if (!frpOs || !frpArch) {
    throw new Error(`Unsupported platform for frpc auto-download: ${os}/${cpu}`);
  }

  return { os: frpOs, arch: frpArch };
}

async function resolveFrpcBinary(explicit?: string): Promise<string> {
  if (explicit && explicit.trim().length > 0) return explicit;
  if (await commandExists("frpc")) return "frpc";

  const target = resolveFrpDownloadTarget();
  const cacheDir = join(tmpdir(), `jonasland-frpc-${FRP_VERSION}-${target.os}-${target.arch}`);
  const archivePath = join(cacheDir, "frpc.tar.gz");
  const unpackDir = join(cacheDir, "unpack");
  const binaryPath = join(cacheDir, "frpc");

  try {
    await access(binaryPath);
    return binaryPath;
  } catch {
    // continue
  }

  await mkdir(unpackDir, { recursive: true });

  const downloadUrl = `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_${target.os}_${target.arch}.tar.gz`;
  const download = await fetch(downloadUrl);
  if (!download.ok || !download.body) {
    throw new Error(`failed downloading frpc from ${downloadUrl} (${download.status})`);
  }
  const archive = Buffer.from(await download.arrayBuffer());
  await writeFile(archivePath, archive);

  const untarExit = await new Promise<number>((resolve) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", unpackDir], { stdio: "ignore" });
    child.once("exit", (code) => resolve(code ?? 1));
    child.once("error", () => resolve(1));
  });
  if (untarExit !== 0) {
    throw new Error(`failed extracting frpc archive ${archivePath}`);
  }

  const extractedDir = join(unpackDir, `frp_${FRP_VERSION}_${target.os}_${target.arch}`);
  const extractedBinary = join(extractedDir, "frpc");
  await copyFile(extractedBinary, binaryPath).catch((error) => {
    throw new Error(
      `failed installing frpc binary from ${extractedBinary}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  await chmod(binaryPath, 0o755);
  await rm(unpackDir, { recursive: true, force: true }).catch(() => {});
  return binaryPath;
}

async function startFrpc(params: {
  controlServerHost: string;
  controlServerPort: number;
  controlTransportProtocol: "websocket" | "wss";
  localTargetHost: string;
  localTargetPort: number;
  frpcBin?: string;
}): Promise<{
  logs: () => string;
  stop: () => Promise<void>;
  waitUntilConnected: () => Promise<void>;
}> {
  const frpcBin = await resolveFrpcBinary(params.frpcBin ?? process.env.JONASLAND_E2E_FRPC_BIN);
  const tmpDir = await mkdtemp(join(tmpdir(), "jonasland-frpc-client-"));
  const configPath = join(tmpDir, "frpc.toml");

  const config = [
    `serverAddr = ${tomlString(params.controlServerHost)}`,
    `serverPort = ${String(params.controlServerPort)}`,
    "loginFailExit = false",
    `transport.protocol = ${tomlString(params.controlTransportProtocol)}`,
    "",
    "[[proxies]]",
    `name = ${tomlString("vitest-mock-egress")}`,
    `type = ${tomlString("tcp")}`,
    `localIP = ${tomlString(params.localTargetHost)}`,
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

    if (child.exitCode === null && child.signalCode === null) {
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

type IngressRouteRecord = {
  routeId: string;
};

async function callIngressProxyProcedure<TResponse>(params: {
  baseUrl: string;
  apiToken: string;
  name: string;
  input: unknown;
}): Promise<TResponse> {
  const response = await fetch(`${params.baseUrl}/api/orpc/${params.name}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ json: params.input }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    json?: TResponse;
    error?: unknown;
  };

  if (!response.ok) {
    throw new Error(
      `ingress proxy ${params.name} failed (${response.status}): ${JSON.stringify(payload.json ?? payload.error ?? payload)}`,
    );
  }

  if (payload.json === undefined) {
    throw new Error(`ingress proxy ${params.name} returned no json payload`);
  }

  return payload.json;
}

async function createIngressRoute(params: {
  baseUrl: string;
  apiToken: string;
  host: string;
  target: string;
  metadata?: Record<string, unknown>;
}): Promise<IngressRouteRecord> {
  return await callIngressProxyProcedure<IngressRouteRecord>({
    baseUrl: params.baseUrl,
    apiToken: params.apiToken,
    name: "createRoute",
    input: {
      metadata: params.metadata ?? {},
      patterns: [
        {
          pattern: params.host,
          target: params.target,
          headers: {
            Host: params.host,
          },
        },
      ],
    },
  });
}

async function deleteIngressRoute(params: {
  baseUrl: string;
  apiToken: string;
  routeId: string;
}): Promise<void> {
  await callIngressProxyProcedure<{ deleted: boolean }>({
    baseUrl: params.baseUrl,
    apiToken: params.apiToken,
    name: "deleteRoute",
    input: {
      routeId: params.routeId,
    },
  });
}

function resolveIngressProxyApiToken(): string {
  const token =
    process.env.INGRESS_PROXY_API_TOKEN ?? process.env.INGRESS_PROXY_E2E_API_TOKEN ?? "";
  if (token.trim().length === 0) {
    throw new Error(
      "Missing ingress proxy API token (set INGRESS_PROXY_API_TOKEN or INGRESS_PROXY_E2E_API_TOKEN)",
    );
  }
  return token;
}

function resolveDockerFrpControlHost(): string {
  const override = process.env.JONASLAND_E2E_DOCKER_FRP_CONTROL_HOST?.trim();
  if (override && override.length > 0) return override;
  return "frp.iterate.localhost";
}

export interface FrpEgressBridge extends AsyncDisposable {
  runId: string;
  dataProxyUrl: string;
  controlServerHost: string;
  controlServerPort: number;
  controlTransportProtocol: "websocket" | "wss";
  clientLogs(): string;
  stop(): Promise<void>;
}

export async function startFrpEgressBridge(params: {
  deployment: Deployment;
  localTargetHost?: string;
  localTargetPort: number;
  frpcBin?: string;
  runId?: string;
}): Promise<FrpEgressBridge> {
  let step = "init";
  let runId = "";
  let controlServerHost = "";
  let controlServerPort = 80;
  let controlTransportProtocol: "websocket" | "wss" = "websocket";
  let dataProxyUrl = "";
  let createdIngressRoute: { baseUrl: string; apiToken: string; routeId: string } | null = null;

  try {
    step = "compute-run-context";
    runId = sanitizeRunId(params.runId);

    const ingressUrl = new URL(
      params.deployment.baseUrl.includes("://")
        ? params.deployment.baseUrl
        : `https://${params.deployment.baseUrl}`,
    );
    const ingressHostname = ingressUrl.hostname.toLowerCase();

    if (ingressHostname.endsWith(".fly.dev") || ingressHostname.endsWith(".ingress.iterate.com")) {
      step = "create-fly-ingress-proxy-route";
      const ingressProxyBaseUrl =
        process.env.JONASLAND_E2E_INGRESS_PROXY_BASE_URL ?? DEFAULT_INGRESS_PROXY_BASE_URL;
      const ingressProxyDomain =
        process.env.JONASLAND_E2E_INGRESS_PROXY_DOMAIN ?? DEFAULT_INGRESS_PROXY_DOMAIN;
      const ingressProxyApiToken = resolveIngressProxyApiToken();

      controlServerHost = `frp__${runId}.${ingressProxyDomain}`;
      controlServerPort = 443;
      controlTransportProtocol = "wss";

      const route = await createIngressRoute({
        baseUrl: ingressProxyBaseUrl,
        apiToken: ingressProxyApiToken,
        host: controlServerHost,
        target: `https://${ingressHostname}`,
        metadata: {
          source: "jonasland-e2e-frp-bridge",
          runId,
          targetHost: ingressHostname,
          createdAt: new Date().toISOString(),
        },
      });

      createdIngressRoute = {
        baseUrl: ingressProxyBaseUrl,
        apiToken: ingressProxyApiToken,
        routeId: route.routeId,
      };
    } else {
      controlServerHost = resolveDockerFrpControlHost();
      controlServerPort = Number.parseInt(ingressUrl.port || "80", 10);
      controlTransportProtocol = "websocket";
    }

    dataProxyUrl = `http://127.0.0.1:${String(FRP_DATA_REMOTE_PORT)}`;

    step = "start-frpc";
    const frpc = await startFrpc({
      controlServerHost,
      controlServerPort,
      controlTransportProtocol,
      localTargetHost: params.localTargetHost ?? "127.0.0.1",
      localTargetPort: params.localTargetPort,
      frpcBin: params.frpcBin,
    });

    try {
      step = "wait-frpc-connected";
      await frpc.waitUntilConnected();
    } catch (error) {
      await frpc.stop().catch(() => {});
      throw new Error(
        `frpc failed to connect (controlServerHost=${controlServerHost}, dataProxyUrl=${dataProxyUrl})`,
        { cause: error },
      );
    }

    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      await frpc.stop().catch(() => {});

      if (createdIngressRoute) {
        await deleteIngressRoute(createdIngressRoute).catch(() => {});
        createdIngressRoute = null;
      }
    };

    return {
      runId,
      dataProxyUrl,
      controlServerHost,
      controlServerPort,
      controlTransportProtocol,
      clientLogs: () => frpc.logs(),
      stop,
      async [Symbol.asyncDispose]() {
        await stop();
      },
    };
  } catch (error) {
    if (createdIngressRoute) {
      await deleteIngressRoute(createdIngressRoute).catch(() => {});
      createdIngressRoute = null;
    }

    throw new Error(
      `startFrpEgressBridge failed during: ${step} (runId=${runId || "n/a"}, controlServerHost=${controlServerHost || "n/a"}, dataProxyUrl=${dataProxyUrl || "n/a"})`,
      { cause: error },
    );
  }
}

// Backward-compatible alias for existing tests.
export const startFlyFrpEgressBridge = startFrpEgressBridge;
export type FlyFrpEgressBridge = FrpEgressBridge;
