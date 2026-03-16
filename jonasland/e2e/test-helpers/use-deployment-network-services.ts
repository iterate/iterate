import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";

const cloudflareTunnelMetricsAddress = "127.0.0.1:20241";
export const FRP_DATA_REMOTE_PORT = 27180;
const FRP_READY_REGEX = /start proxy success|proxy added successfully|login to server success/i;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tomlString(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function teardownManagedProcess(params: {
  deployment: Deployment;
  processSlug: string;
  routeHost?: string;
}) {
  if (process.env.E2E_NO_DISPOSE) return;
  if (params.routeHost) {
    await params.deployment.registryService.routes
      .remove({ host: params.routeHost })
      .catch(() => {});
  }
  await params.deployment.pidnap.processes
    .delete({ processSlug: params.processSlug })
    .catch(() => {});
}

export async function waitForResolvedPublicUrl(params: {
  deployment: Deployment;
  internalURL: string;
  expectedPublicURL: string;
  timeoutMs: number;
}) {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resolved = await params.deployment.registryService.getPublicURL({
        internalURL: params.internalURL,
      });
      if (resolved.publicURL === params.expectedPublicURL) {
        return resolved.publicURL;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error(
    `Timed out waiting for registry public URL ${params.expectedPublicURL} for ${params.internalURL}`,
  );
}

export async function useDeploymentManagedCloudflareTunnel(params: {
  deployment: Deployment;
  tunnelToken: string;
  publicURL: string;
  processSlug?: string;
  timeoutMs?: number;
}) {
  const processSlug = params.processSlug ?? "cloudflare-tunnel";
  const timeoutMs = params.timeoutMs ?? 60_000;
  let disposed = false;

  await params.deployment.pidnap.processes.updateConfig({
    processSlug,
    definition: {
      command: "sh",
      args: [
        "-lc",
        [
          'exec cloudflared tunnel --metrics 127.0.0.1:20241 run --token "$CLOUDFLARE_TUNNEL_TOKEN"',
        ].join("\n"),
      ],
      env: {
        CLOUDFLARE_TUNNEL_TOKEN: params.tunnelToken,
      },
    },
    options: {
      restartPolicy: "always",
    },
    healthCheck: {
      url: `http://${cloudflareTunnelMetricsAddress}/ready`,
      intervalMs: 2_000,
    },
    tags: ["e2e", "network", "cloudflare-tunnel"],
    restartImmediately: true,
  });

  await params.deployment.pidnap.processes.waitFor({
    processes: {
      [processSlug]: "healthy",
    },
    timeoutMs,
  });

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await teardownManagedProcess({
      deployment: params.deployment,
      processSlug,
    });
  };

  return {
    processSlug,
    publicURL: params.publicURL,
    dispose,
    async [Symbol.asyncDispose]() {
      await dispose();
    },
  };
}

export async function useDeploymentManagedFrpService(params: {
  deployment: Deployment;
  publicBaseHost?: string;
  processSlug?: string;
  internalHost?: string;
  timeoutMs?: number;
}) {
  const processSlug = params.processSlug ?? "frps";
  const internalHost = params.internalHost ?? "frp.iterate.localhost";
  const timeoutMs = params.timeoutMs ?? 60_000;
  let disposed = false;

  await params.deployment.pidnap.processes.updateConfig({
    processSlug,
    definition: {
      command: "sh",
      args: [
        "-lc",
        'exec /usr/local/bin/frps -c "${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}/jonasland/sandbox/frps.toml"',
      ],
    },
    options: {
      restartPolicy: "always",
    },
    tags: ["e2e", "network", "frp"],
    restartImmediately: true,
  });

  await params.deployment.registryService.routes.upsert({
    host: internalHost,
    target: "127.0.0.1:27000",
    caddyDirectives: ["stream_close_delay 5m"],
    tags: ["e2e", "network", "frp"],
    metadata: {
      source: "jonasland-e2e-runtime-frp",
      title: "FRP",
    },
  });

  await params.deployment.pidnap.processes.waitFor({
    processes: {
      [processSlug]: "running",
    },
    timeoutMs,
  });

  const internalURL = `http://${internalHost}`;
  const publicURL = params.publicBaseHost
    ? await waitForResolvedPublicUrl({
        deployment: params.deployment,
        internalURL,
        expectedPublicURL: `https://frp__${params.publicBaseHost}/`,
        timeoutMs,
      })
    : undefined;

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await teardownManagedProcess({
      deployment: params.deployment,
      processSlug,
      routeHost: internalHost,
    });
  };

  return {
    processSlug,
    internalHost,
    internalURL,
    publicURL,
    dispose,
    async [Symbol.asyncDispose]() {
      await dispose();
    },
  };
}

export async function useFrpTunnelToPublicDeployment(params: {
  publicBaseHost: string;
  localTargetPort: number;
  localTargetHost?: string;
  name: string;
  frpcBin?: string;
}) {
  const tmpDir = await mkdtemp(join(tmpdir(), "jonasland-e2e-frpc-"));
  const configPath = join(tmpDir, "frpc.toml");
  const controlHost = `frp__${params.publicBaseHost}`;
  await writeFile(
    configPath,
    [
      `serverAddr = ${tomlString(controlHost)}`,
      "serverPort = 443",
      `transport.protocol = ${tomlString("wss")}`,
      "loginFailExit = false",
      "",
      "[[proxies]]",
      `name = ${tomlString(params.name)}`,
      `type = ${tomlString("tcp")}`,
      `localIP = ${tomlString(params.localTargetHost ?? "127.0.0.1")}`,
      `localPort = ${String(params.localTargetPort)}`,
      `remotePort = ${String(FRP_DATA_REMOTE_PORT)}`,
      "",
    ].join("\n"),
    "utf8",
  );

  const logs: string[] = [];
  const frpc = spawn(
    params.frpcBin?.trim() || process.env.JONASLAND_E2E_FRPC_BIN || "frpc",
    ["-c", configPath],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  frpc.stdout.on("data", (chunk) => {
    logs.push(String(chunk));
  });
  frpc.stderr.on("data", (chunk) => {
    logs.push(String(chunk));
  });

  let disposed = false;
  const stop = async () => {
    if (disposed) return;
    disposed = true;
    if (frpc.exitCode === null && frpc.signalCode === null) {
      frpc.kill("SIGTERM");
      await sleep(500);
    }
    if (frpc.exitCode === null && frpc.signalCode === null) {
      frpc.kill("SIGKILL");
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };

  const waitUntilConnected = async () => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (frpc.exitCode !== null) {
        throw new Error(`frpc exited early with code ${String(frpc.exitCode)}:\n${logs.join("")}`);
      }
      if (FRP_READY_REGEX.test(logs.join(""))) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for frpc to connect:\n${logs.join("")}`);
  };

  return {
    proxyUrl: `http://127.0.0.1:${String(FRP_DATA_REMOTE_PORT)}`,
    logs: () => logs.join(""),
    stop,
    waitUntilConnected,
    async [Symbol.asyncDispose]() {
      await stop();
    },
  };
}
