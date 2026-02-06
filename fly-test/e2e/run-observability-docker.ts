import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fetchWithDnsFallback,
  postFormWithDnsFallback,
  readFileOrEmpty,
  runCommand,
  sleep,
  type CommandResult,
  urlEncodedForm,
} from "./run-observability-lib.ts";

export type DockerRunnerConfig = {
  flyDir: string;
  artifactDir: string;
  app: string;
  targetUrl: string;
  cleanupOnExit: boolean;
  log: (line: string) => void;
};

type NetworkPlan = {
  subnetCidr: string;
  gatewayIp: string;
  sandboxIp: string;
  egressProxyIp: string;
  upstreamIp: string;
  sandboxTunnelIp: string;
  egressTunnelIp: string;
};

type PublishedPorts = {
  sandboxHostPort: number | null;
  egressViewerHostPort: number | null;
  upstreamHostPort: number | null;
};

const run = runCommand;

function hashText(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildNetworkPlan(project: string): NetworkPlan {
  const octet = 20 + (hashText(project) % 200);
  const prefix = `10.250.${octet}`;
  return {
    subnetCidr: `${prefix}.0/24`,
    gatewayIp: `${prefix}.2`,
    sandboxIp: `${prefix}.3`,
    egressProxyIp: `${prefix}.4`,
    upstreamIp: `${prefix}.5`,
    sandboxTunnelIp: `${prefix}.10`,
    egressTunnelIp: `${prefix}.11`,
  };
}

function parseTryCloudflareUrl(text: string): string | null {
  const matches = text.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/g);
  if (!matches) return null;
  return matches.find((url) => url !== "https://api.trycloudflare.com") ?? null;
}

function dockerCompose(
  composeFile: string,
  project: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
): CommandResult {
  return run("docker", ["compose", "-f", composeFile, "-p", project, ...args], options);
}

function parsePublishedPort(output: string): number | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const line of lines) {
    const match = line.match(/:(\d+)\s*$/);
    if (!match) continue;
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  }
  return null;
}

function discoverPublishedPort(
  composeFile: string,
  project: string,
  service: string,
  containerPort: number,
  env: NodeJS.ProcessEnv,
): number | null {
  const result = dockerCompose(composeFile, project, ["port", service, String(containerPort)], {
    env,
    allowFailure: true,
  });
  if (result.status !== 0) return null;
  return parsePublishedPort(`${result.stdout}\n${result.stderr}`);
}

function discoverPublishedPorts(
  composeFile: string,
  project: string,
  env: NodeJS.ProcessEnv,
): PublishedPorts {
  return {
    sandboxHostPort: discoverPublishedPort(composeFile, project, "sandbox-ui", 8080, env),
    egressViewerHostPort: discoverPublishedPort(composeFile, project, "egress-proxy", 18081, env),
    upstreamHostPort: discoverPublishedPort(composeFile, project, "public-http", 18090, env),
  };
}

async function waitForHealthChecks(
  composeFile: string,
  project: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const mitmImpl = env["MITM_IMPL"] === "dump" ? "dump" : "go";
  const egressHealthCmd =
    mitmImpl === "go"
      ? "curl -fsS --max-time 2 http://127.0.0.1:18081/healthz >/dev/null && curl -fsS --max-time 2 http://127.0.0.1:18080/healthz >/dev/null"
      : "curl -fsS --max-time 2 http://127.0.0.1:18081/healthz >/dev/null && curl -sS --max-time 2 http://127.0.0.1:18080 >/dev/null";
  for (let attempt = 1; attempt <= 120; attempt += 1) {
    if (attempt % 3 === 0) {
      const ps = dockerCompose(composeFile, project, ["ps", "-a", "--format", "json"], {
        env,
        allowFailure: true,
      });
      const records = ps.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as { Service?: string; State?: string; ExitCode?: string };
          } catch {
            return null;
          }
        })
        .filter(
          (value): value is { Service?: string; State?: string; ExitCode?: string } =>
            value !== null,
        );
      for (const service of ["egress-gateway", "egress-proxy", "sandbox-ui"] as const) {
        const record = records.find((item) => item.Service === service);
        if (!record) continue;
        const state = (record.State ?? "").toLowerCase();
        if (state === "exited" || state === "dead") {
          throw new Error(
            `docker service exited before healthy: service=${service} state=${record.State ?? "unknown"} exit_code=${record.ExitCode ?? "unknown"}`,
          );
        }
      }
    }

    const egress = dockerCompose(
      composeFile,
      project,
      ["exec", "-T", "egress-proxy", "sh", "-lc", egressHealthCmd],
      { env, allowFailure: true },
    );
    const sandbox = dockerCompose(
      composeFile,
      project,
      [
        "exec",
        "-T",
        "sandbox-ui",
        "sh",
        "-lc",
        "curl -fsS --max-time 2 http://127.0.0.1:8080/healthz >/dev/null",
      ],
      { env, allowFailure: true },
    );
    const gateway = dockerCompose(
      composeFile,
      project,
      ["exec", "-T", "egress-gateway", "sh", "-lc", "test -f /tmp/gateway-ready"],
      { env, allowFailure: true },
    );

    if (egress.status === 0 && sandbox.status === 0 && gateway.status === 0) return;
    await sleep(2000);
  }
  throw new Error("docker services did not become healthy in time");
}

async function waitForTunnelUrl(
  composeFile: string,
  project: string,
  service: "sandbox-tunnel" | "egress-tunnel",
  env: NodeJS.ProcessEnv,
  options: { required?: boolean; maxAttempts?: number } = {},
): Promise<string | null> {
  const maxAttempts = options.maxAttempts ?? 180;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const logs = dockerCompose(composeFile, project, ["logs", "--no-color", service], {
      env,
      allowFailure: true,
    });
    const url = parseTryCloudflareUrl(`${logs.stdout}\n${logs.stderr}`);
    if (url) return url;
    await sleep(2000);
  }
  if (options.required ?? true) {
    throw new Error(`tunnel URL not found for service=${service}`);
  }
  return null;
}

function collectComposeLogs(
  composeFile: string,
  project: string,
  service: string,
  outputPath: string,
  env: NodeJS.ProcessEnv,
): void {
  const result = dockerCompose(composeFile, project, ["logs", "--no-color", service], {
    env,
    allowFailure: true,
  });
  writeFileSync(outputPath, `${result.stdout}${result.stderr}`);
}

function collectContainerFile(
  composeFile: string,
  project: string,
  service: string,
  remotePath: string,
  outputPath: string,
  env: NodeJS.ProcessEnv,
): void {
  const result = dockerCompose(
    composeFile,
    project,
    ["exec", "-T", service, "sh", "-lc", `cat ${remotePath}`],
    { env, allowFailure: true },
  );
  writeFileSync(outputPath, `${result.stdout}${result.stderr}`);
}

function collectDockerMetadata(
  composeFile: string,
  project: string,
  outputPath: string,
  env: NodeJS.ProcessEnv,
): void {
  const ps = dockerCompose(composeFile, project, ["ps", "--format", "json"], {
    env,
    allowFailure: true,
  });
  const lines = ps.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return line;
      }
    });
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        composeFile,
        project,
        services: lines,
      },
      null,
      2,
    ),
  );
}

export async function runDockerObservability(config: DockerRunnerConfig): Promise<void> {
  mkdirSync(config.artifactDir, { recursive: true });
  const log = (line: string): void => {
    config.log(line);
  };

  const composeFile = join(config.flyDir, "docker-compose.local.yml");
  const project = config.app;
  const network = buildNetworkPlan(project);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SANDBOX_HOST_PORT: process.env["SANDBOX_HOST_PORT"] ?? "0",
    EGRESS_VIEWER_HOST_PORT: process.env["EGRESS_VIEWER_HOST_PORT"] ?? "0",
    UPSTREAM_HOST_PORT: process.env["UPSTREAM_HOST_PORT"] ?? "0",
    TARGET_URL: config.targetUrl,
    FLY_TEST_SUBNET_CIDR: network.subnetCidr,
    EGRESS_GATEWAY_IP: network.gatewayIp,
    SANDBOX_IP: network.sandboxIp,
    EGRESS_PROXY_IP: network.egressProxyIp,
    UPSTREAM_IP: network.upstreamIp,
    SANDBOX_TUNNEL_IP: network.sandboxTunnelIp,
    EGRESS_TUNNEL_IP: network.egressTunnelIp,
  };
  const mitmImpl = env["MITM_IMPL"] === "dump" ? "dump" : "go";

  let shouldCleanup = config.cleanupOnExit;
  try {
    log(`Starting docker compose stack: project=${project}`);
    log(`Docker subnet: ${network.subnetCidr}`);
    log(`MITM impl: ${mitmImpl}`);
    const up = dockerCompose(composeFile, project, ["up", "-d", "--build"], {
      env,
      allowFailure: true,
    });
    writeFileSync(join(config.artifactDir, "docker-up.log"), `${up.stdout}${up.stderr}`);
    if (up.status !== 0) {
      const downOnFail = dockerCompose(composeFile, project, ["down", "-v", "--timeout", "5"], {
        env,
        allowFailure: true,
      });
      writeFileSync(
        join(config.artifactDir, "docker-down-on-up-failure.log"),
        `${downOnFail.stdout}${downOnFail.stderr}`,
      );
      throw new Error(
        [
          `docker compose up failed`,
          up.stdout.length > 0 ? `stdout:\n${up.stdout}` : "",
          up.stderr.length > 0 ? `stderr:\n${up.stderr}` : "",
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
      );
    }

    const publishedPorts = discoverPublishedPorts(composeFile, project, env);
    writeFileSync(
      join(config.artifactDir, "published-host-ports.json"),
      `${JSON.stringify(publishedPorts, null, 2)}\n`,
    );
    if (publishedPorts.sandboxHostPort !== null) {
      log(`Sandbox local URL: http://127.0.0.1:${publishedPorts.sandboxHostPort}`);
    }
    if (publishedPorts.egressViewerHostPort !== null) {
      log(`Egress viewer local URL: http://127.0.0.1:${publishedPorts.egressViewerHostPort}`);
    }
    if (publishedPorts.upstreamHostPort !== null) {
      log(`Upstream local URL: http://127.0.0.1:${publishedPorts.upstreamHostPort}`);
    }
    if (publishedPorts.sandboxHostPort === null) {
      throw new Error("sandbox host port was not published");
    }
    if (publishedPorts.egressViewerHostPort === null) {
      throw new Error("egress viewer host port was not published");
    }
    const sandboxLocalUrl = `http://127.0.0.1:${publishedPorts.sandboxHostPort}`;
    const egressViewerLocalUrl = `http://127.0.0.1:${publishedPorts.egressViewerHostPort}`;
    writeFileSync(join(config.artifactDir, "sandbox-local-url.txt"), `${sandboxLocalUrl}\n`);
    writeFileSync(
      join(config.artifactDir, "egress-viewer-local-url.txt"),
      `${egressViewerLocalUrl}\n`,
    );

    log("Waiting for gateway + app service health checks");
    await waitForHealthChecks(composeFile, project, env);

    log("Attempting to discover cloudflared tunnel URLs (best-effort)");
    const [sandboxUrl, egressViewerUrl] = await Promise.all([
      waitForTunnelUrl(composeFile, project, "sandbox-tunnel", env, {
        required: false,
        maxAttempts: 10,
      }),
      waitForTunnelUrl(composeFile, project, "egress-tunnel", env, {
        required: false,
        maxAttempts: 10,
      }),
    ]);
    if (sandboxUrl) {
      writeFileSync(join(config.artifactDir, "sandbox-url.txt"), `${sandboxUrl}\n`);
      log(`Sandbox tunnel URL: ${sandboxUrl}`);
    } else {
      log("WARN sandbox tunnel URL was not discovered in time");
    }
    if (egressViewerUrl) {
      writeFileSync(join(config.artifactDir, "egress-viewer-url.txt"), `${egressViewerUrl}\n`);
      log(`Egress viewer tunnel URL: ${egressViewerUrl}`);
    } else {
      log("WARN egress viewer tunnel URL was not discovered in time");
    }

    log("Checking both pages from host (local published ports)");
    await fetchWithDnsFallback(
      run,
      `${sandboxLocalUrl}/`,
      join(config.artifactDir, "sandbox-home.html"),
      join(config.artifactDir, "sandbox-home.stderr"),
    );
    await fetchWithDnsFallback(
      run,
      `${egressViewerLocalUrl}/`,
      join(config.artifactDir, "egress-viewer-home.html"),
      join(config.artifactDir, "egress-viewer-home.stderr"),
    );

    log(`Triggering outbound fetch via sandbox API (local): ${config.targetUrl}`);
    await postFormWithDnsFallback(
      run,
      `${sandboxLocalUrl}/api/fetch`,
      urlEncodedForm({ url: config.targetUrl }),
      join(config.artifactDir, "sandbox-fetch-response.json"),
      join(config.artifactDir, "sandbox-fetch.stderr"),
    );

    log("Collecting docker logs and runtime artifacts");
    collectComposeLogs(
      composeFile,
      project,
      "sandbox-ui",
      join(config.artifactDir, "sandbox-compose.log"),
      env,
    );
    collectComposeLogs(
      composeFile,
      project,
      "egress-proxy",
      join(config.artifactDir, "egress-compose.log"),
      env,
    );
    collectComposeLogs(
      composeFile,
      project,
      "egress-gateway",
      join(config.artifactDir, "gateway-compose.log"),
      env,
    );
    collectComposeLogs(
      composeFile,
      project,
      "sandbox-tunnel",
      join(config.artifactDir, "sandbox-tunnel.log"),
      env,
    );
    collectComposeLogs(
      composeFile,
      project,
      "egress-tunnel",
      join(config.artifactDir, "egress-tunnel.log"),
      env,
    );

    collectContainerFile(
      composeFile,
      project,
      "sandbox-ui",
      "/tmp/sandbox-ui.log",
      join(config.artifactDir, "sandbox-ui.log"),
      env,
    );
    collectContainerFile(
      composeFile,
      project,
      "sandbox-ui",
      "/tmp/sandbox-init.log",
      join(config.artifactDir, "sandbox-init.log"),
      env,
    );
    collectContainerFile(
      composeFile,
      project,
      "sandbox-ui",
      "/tmp/sandbox-routes.txt",
      join(config.artifactDir, "sandbox-routes.txt"),
      env,
    );
    collectContainerFile(
      composeFile,
      project,
      "egress-proxy",
      "/tmp/egress-proxy.log",
      join(config.artifactDir, "egress-proxy.log"),
      env,
    );
    collectContainerFile(
      composeFile,
      project,
      "egress-proxy",
      "/tmp/egress-init.log",
      join(config.artifactDir, "egress-init.log"),
      env,
    );
    collectContainerFile(
      composeFile,
      project,
      "egress-gateway",
      "/tmp/gateway-init.log",
      join(config.artifactDir, "gateway-init.log"),
      env,
    );
    collectContainerFile(
      composeFile,
      project,
      "egress-gateway",
      "/tmp/gateway-flow.log",
      join(config.artifactDir, "gateway-flow.log"),
      env,
    );
    collectContainerFile(
      composeFile,
      project,
      "egress-gateway",
      "/tmp/gateway-dns.log",
      join(config.artifactDir, "gateway-dns.log"),
      env,
    );
    collectContainerFile(
      composeFile,
      project,
      "egress-gateway",
      "/tmp/gateway-iptables.txt",
      join(config.artifactDir, "gateway-iptables.txt"),
      env,
    );
    collectDockerMetadata(
      composeFile,
      project,
      join(config.artifactDir, "docker-metadata.json"),
      env,
    );

    const sandboxLog = readFileOrEmpty(join(config.artifactDir, "sandbox-ui.log"));
    const sandboxInit = readFileOrEmpty(join(config.artifactDir, "sandbox-init.log"));
    const egressLog = readFileOrEmpty(join(config.artifactDir, "egress-proxy.log"));
    const dnsLog = readFileOrEmpty(join(config.artifactDir, "gateway-dns.log"));
    const flowLog = readFileOrEmpty(join(config.artifactDir, "gateway-flow.log"));
    const sandboxFetchResponseRaw = readFileOrEmpty(
      join(config.artifactDir, "sandbox-fetch-response.json"),
    );

    if (!/FETCH_(OK|ERROR)/.test(sandboxLog)) {
      throw new Error("sandbox did not report fetch attempt");
    }
    if (!/transparent_redirect=enabled/.test(sandboxInit)) {
      throw new Error("sandbox did not enable transparent gateway routing");
    }
    if (!/(MITM_REQUEST|MITM_RESPONSE|TRANSFORM_OK)/.test(egressLog)) {
      throw new Error("egress log does not show MITM transform event");
    }
    if (!/query\[/.test(dnsLog)) {
      throw new Error("gateway DNS log does not show query metadata");
    }
    if (flowLog.trim().length === 0) {
      throw new Error("gateway flow log is empty");
    }

    let sandboxFetchResponse: { ok?: boolean; body?: string; proofDetected?: boolean };
    try {
      sandboxFetchResponse = JSON.parse(sandboxFetchResponseRaw) as {
        ok?: boolean;
        body?: string;
        proofDetected?: boolean;
      };
    } catch {
      throw new Error("sandbox fetch response was not valid json");
    }

    if (!sandboxFetchResponse.ok) {
      throw new Error("sandbox fetch response was not ok");
    }
    if (
      !sandboxFetchResponse.proofDetected &&
      !sandboxFetchResponse.body?.startsWith("__ITERATE_MITM_PROOF__")
    ) {
      throw new Error("sandbox response did not include MITM proof prefix");
    }

    log("SUCCESS");
    log("Open side-by-side:");
    log(`  sandbox local: ${sandboxLocalUrl}`);
    log(`  egress viewer local: ${egressViewerLocalUrl}`);
    if (sandboxUrl) log(`  sandbox tunnel: ${sandboxUrl}`);
    if (egressViewerUrl) log(`  egress viewer tunnel: ${egressViewerUrl}`);
    log(`Artifacts: ${config.artifactDir}`);
    log("Tail egress log live:");
    log(`  docker compose -f ${composeFile} -p ${project} logs -f egress-proxy`);

    if (!config.cleanupOnExit) {
      log("Destroy when done:");
      log(`  docker compose -f ${composeFile} -p ${project} down -v --timeout 5`);
      shouldCleanup = false;
    }
  } finally {
    if (shouldCleanup) {
      const down = dockerCompose(composeFile, project, ["down", "-v", "--timeout", "5"], {
        env,
        allowFailure: true,
      });
      writeFileSync(join(config.artifactDir, "docker-down.log"), `${down.stdout}${down.stderr}`);
    }
  }
}
