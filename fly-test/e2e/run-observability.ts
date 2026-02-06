#!/usr/bin/env tsx
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { hostFromUrl, proxyHostForIp, urlEncodedForm } from "./run-observability-lib.ts";

type Machine = {
  id: string;
  name: string;
  private_ip?: string;
};

type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type RunnerConfig = {
  flyDir: string;
  artifactDir: string;
  app: string;
  org: string;
  region: string;
  targetUrl: string;
  runtimeImage: string;
};

const EGRESS_MACHINE_NAME = "egress-proxy";
const SANDBOX_MACHINE_NAME = "sandbox-ui";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
}

function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
): CommandResult {
  const result = spawnSync(command, args, {
    env: options.env ?? process.env,
    encoding: "utf8",
  });
  const status = result.status ?? 1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (!options.allowFailure && status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        `status=${status}`,
        stdout.length > 0 ? `stdout:\n${stdout}` : "",
        stderr.length > 0 ? `stderr:\n${stderr}` : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
    );
  }
  return { status, stdout, stderr };
}

function nowTag(): string {
  const date = new Date();
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${two(date.getMonth() + 1)}${two(date.getDate())}${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

function findFlyDir(): string {
  const cwd = process.cwd();
  if (cwd.endsWith("/fly-test")) return cwd;
  return join(cwd, "fly-test");
}

function buildConfig(): RunnerConfig {
  const flyDir = findFlyDir();
  const app = process.env["APP_NAME"] ?? `iterate-node-egress-obsv-${nowTag()}`;
  const org = process.env["FLY_ORG"] ?? "iterate";
  const region = process.env["FLY_REGION"] ?? "iad";
  const targetUrl = process.env["TARGET_URL"] ?? "https://example.com/";
  const runtimeImage = resolveRuntimeImage(flyDir);
  const artifactDir = join(flyDir, "proof-logs", app);
  mkdirSync(artifactDir, { recursive: true });
  return { flyDir, artifactDir, app, org, region, targetUrl, runtimeImage };
}

function resolveRuntimeImage(flyDir: string): string {
  const fromEnv = process.env["FLY_TEST_RUNTIME_IMAGE"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const cachePath = join(flyDir, ".cache", "runtime-image.txt");
  if (existsSync(cachePath)) {
    const value = readFileSync(cachePath, "utf8").trim();
    if (value.length > 0) return value;
  }

  throw new Error(
    `Missing runtime image. Run: doppler run --config dev -- bash ${join(flyDir, "scripts", "build-runtime-image.sh")}`,
  );
}

function makeLogger(summaryPath: string): (line: string) => void {
  return (line: string): void => {
    process.stdout.write(`${line}\n`);
    appendFileSync(summaryPath, `${line}\n`);
  };
}

function listMachines(app: string, env: NodeJS.ProcessEnv): Machine[] {
  const result = run("flyctl", ["machine", "list", "-a", app, "--json"], { env });
  return JSON.parse(result.stdout) as Machine[];
}

function findMachineByName(machines: Machine[], name: string): Machine {
  const machine = machines.find((value) => value.name === name);
  if (!machine) throw new Error(`machine not found: ${name}`);
  return machine;
}

function collectMachineFile(
  app: string,
  machineId: string,
  remotePath: string,
  outputPath: string,
  env: NodeJS.ProcessEnv,
): void {
  const result = run("flyctl", ["machine", "exec", machineId, `cat ${remotePath}`, "-a", app], {
    env,
    allowFailure: true,
  });
  writeFileSync(outputPath, `${result.stdout}${result.stderr}`);
}

async function waitForMachineUrlFile(
  app: string,
  machineId: string,
  remotePath: string,
  localPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  for (let attempt = 1; attempt <= 150; attempt += 1) {
    if (attempt % 5 === 0) {
      const statusResult = run("flyctl", ["machine", "status", machineId, "-a", app, "--json"], {
        env,
        allowFailure: true,
      });
      if (statusResult.status === 0) {
        const parsed = JSON.parse(statusResult.stdout) as { state?: string };
        const state = parsed.state ?? "unknown";
        if (state !== "starting" && state !== "started") {
          throw new Error(`machine not running: machine=${machineId} state=${state}`);
        }
      }
    }

    const result = run("flyctl", ["machine", "exec", machineId, `cat ${remotePath}`, "-a", app], {
      env,
      allowFailure: true,
    });
    const combined = `${result.stdout}${result.stderr}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const maybeUrl = combined.find((line) =>
      /^https:\/\/[-a-z0-9]+\.trycloudflare\.com$/.test(line),
    );
    if (result.status === 0 && maybeUrl) {
      writeFileSync(localPath, `${maybeUrl}\n`);
      return maybeUrl;
    }
    await sleep(2000);
  }
  throw new Error(`machine URL file not ready: machine=${machineId} path=${remotePath}`);
}

async function fetchWithDnsFallback(
  url: string,
  outputPath: string,
  stderrPath: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const result = run("curl", ["-fsS", "--max-time", "25", url], { allowFailure: true });
    if (result.status === 0) {
      writeFileSync(outputPath, result.stdout);
      writeFileSync(stderrPath, result.stderr);
      return;
    }
    await sleep(1000);
  }

  const host = hostFromUrl(url).split(":")[0];
  const dns = run("dig", ["+short", host, "@1.1.1.1"], { allowFailure: true });
  const ip = dns.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!ip) throw new Error(`DNS lookup failed for ${host}`);

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const result = run(
      "curl",
      ["-fsS", "--max-time", "25", "--resolve", `${host}:443:${ip}`, url],
      {
        allowFailure: true,
      },
    );
    if (result.status === 0) {
      writeFileSync(outputPath, result.stdout);
      writeFileSync(stderrPath, result.stderr);
      return;
    }
    await sleep(1000);
  }
  throw new Error(`unable to fetch URL: ${url}`);
}

async function postFormWithDnsFallback(
  url: string,
  body: string,
  outputPath: string,
  stderrPath: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const result = run("curl", ["-sS", "--max-time", "75", "--data", body, url], {
      allowFailure: true,
    });
    if (result.status === 0) {
      writeFileSync(outputPath, result.stdout);
      writeFileSync(stderrPath, result.stderr);
      return;
    }
    await sleep(1000);
  }

  const host = hostFromUrl(url).split(":")[0];
  const dns = run("dig", ["+short", host, "@1.1.1.1"], { allowFailure: true });
  const ip = dns.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!ip) throw new Error(`DNS lookup failed for ${host}`);

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const result = run(
      "curl",
      ["-sS", "--max-time", "75", "--resolve", `${host}:443:${ip}`, "--data", body, url],
      { allowFailure: true },
    );
    if (result.status === 0) {
      writeFileSync(outputPath, result.stdout);
      writeFileSync(stderrPath, result.stderr);
      return;
    }
    await sleep(1000);
  }
  throw new Error(`unable to post form: ${url}`);
}

function readFileOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const flyApiKey = requireEnv("FLY_API_KEY");
  const config = buildConfig();
  const summaryPath = join(config.artifactDir, "summary.txt");
  const log = makeLogger(summaryPath);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FLY_API_TOKEN: flyApiKey,
  };

  run("flyctl", ["version"]);
  run("jq", ["--version"]);
  run("dig", ["+short", "example.com"]);
  log(`Runtime image: ${config.runtimeImage}`);

  log(`Creating app: ${config.app} (org=${config.org} region=${config.region})`);
  const appCreate = run("flyctl", ["apps", "create", config.app, "-o", config.org, "-y"], { env });
  writeFileSync(
    join(config.artifactDir, "app-create.log"),
    `${appCreate.stdout}${appCreate.stderr}`,
  );

  log("Launching egress proxy/viewer machine");
  const egressRun = run(
    "flyctl",
    [
      "machine",
      "run",
      config.runtimeImage,
      "/bin/bash",
      "/proof/egress-proxy/start.sh",
      "-a",
      config.app,
      "-r",
      config.region,
      "--name",
      EGRESS_MACHINE_NAME,
      "--restart",
      "always",
      "--detach",
      "--vm-memory",
      "1024",
      "-e",
      `PROOF_REGION=${config.region}`,
    ],
    { env },
  );
  writeFileSync(
    join(config.artifactDir, "egress-machine-run.log"),
    `${egressRun.stdout}${egressRun.stderr}`,
  );

  const egress = findMachineByName(listMachines(config.app, env), EGRESS_MACHINE_NAME);
  if (!egress.private_ip) throw new Error("egress machine private_ip missing");
  const egressHost = proxyHostForIp(egress.private_ip);
  writeFileSync(join(config.artifactDir, "egress-machine-id.txt"), `${egress.id}\n`);
  writeFileSync(join(config.artifactDir, "egress-machine-ip.txt"), `${egress.private_ip}\n`);
  log(`Egress machine: id=${egress.id} private_ip=${egress.private_ip} host=${egressHost}`);

  log("Launching sandbox machine with CA trust + proxy env");
  const sandboxRun = run(
    "flyctl",
    [
      "machine",
      "run",
      config.runtimeImage,
      "/bin/bash",
      "/proof/sandbox/start.sh",
      "-a",
      config.app,
      "-r",
      config.region,
      "--name",
      SANDBOX_MACHINE_NAME,
      "--restart",
      "always",
      "--detach",
      "--vm-memory",
      "1024",
      "-e",
      `PROOF_REGION=${config.region}`,
      "-e",
      `EGRESS_PROXY_HOST=${egressHost}`,
      "-e",
      "EGRESS_MITM_PORT=18080",
      "-e",
      "EGRESS_VIEWER_PORT=18081",
      "-e",
      `DEFAULT_TARGET_URL=${config.targetUrl}`,
    ],
    { env },
  );
  writeFileSync(
    join(config.artifactDir, "sandbox-machine-run.log"),
    `${sandboxRun.stdout}${sandboxRun.stderr}`,
  );

  const sandbox = findMachineByName(listMachines(config.app, env), SANDBOX_MACHINE_NAME);
  writeFileSync(join(config.artifactDir, "sandbox-machine-id.txt"), `${sandbox.id}\n`);
  log(`Sandbox machine: id=${sandbox.id}`);

  log("Waiting for cloudflared tunnel URLs from both machines");
  const egressViewerUrl = await waitForMachineUrlFile(
    config.app,
    egress.id,
    "/tmp/egress-viewer-tunnel-url.txt",
    join(config.artifactDir, "egress-viewer-url.txt"),
    env,
  );
  const sandboxUrl = await waitForMachineUrlFile(
    config.app,
    sandbox.id,
    "/tmp/sandbox-tunnel-url.txt",
    join(config.artifactDir, "sandbox-url.txt"),
    env,
  );
  log(`Egress viewer URL: ${egressViewerUrl}`);
  log(`Sandbox URL: ${sandboxUrl}`);

  log("Checking both pages from host");
  await fetchWithDnsFallback(
    egressViewerUrl,
    join(config.artifactDir, "egress-viewer-home.html"),
    join(config.artifactDir, "egress-viewer-home.stderr"),
  );
  await fetchWithDnsFallback(
    sandboxUrl,
    join(config.artifactDir, "sandbox-home.html"),
    join(config.artifactDir, "sandbox-home.stderr"),
  );

  log(`Triggering outbound fetch via sandbox API: ${config.targetUrl}`);
  await postFormWithDnsFallback(
    `${sandboxUrl}/api/fetch`,
    urlEncodedForm({ url: config.targetUrl }),
    join(config.artifactDir, "sandbox-fetch-response.json"),
    join(config.artifactDir, "sandbox-fetch.stderr"),
  );

  log("Collecting logs from both machines");
  collectMachineFile(
    config.app,
    egress.id,
    "/tmp/egress-proxy.log",
    join(config.artifactDir, "egress-proxy.log"),
    env,
  );
  collectMachineFile(
    config.app,
    egress.id,
    "/tmp/egress-init.log",
    join(config.artifactDir, "egress-init.log"),
    env,
  );
  collectMachineFile(
    config.app,
    egress.id,
    "/tmp/egress-tunnel.log",
    join(config.artifactDir, "egress-tunnel.log"),
    env,
  );
  collectMachineFile(
    config.app,
    sandbox.id,
    "/tmp/sandbox-ui.log",
    join(config.artifactDir, "sandbox-ui.log"),
    env,
  );
  collectMachineFile(
    config.app,
    sandbox.id,
    "/tmp/sandbox-init.log",
    join(config.artifactDir, "sandbox-init.log"),
    env,
  );
  collectMachineFile(
    config.app,
    sandbox.id,
    "/tmp/sandbox-tunnel.log",
    join(config.artifactDir, "sandbox-tunnel.log"),
    env,
  );

  const sandboxLog = readFileOrEmpty(join(config.artifactDir, "sandbox-ui.log"));
  const egressLog = readFileOrEmpty(join(config.artifactDir, "egress-proxy.log"));
  const sandboxFetchResponseRaw = readFileOrEmpty(
    join(config.artifactDir, "sandbox-fetch-response.json"),
  );
  const sandboxFetchResponse = JSON.parse(sandboxFetchResponseRaw) as {
    ok?: boolean;
    body?: string;
    proofDetected?: boolean;
  };
  if (!/FETCH_(OK|ERROR)/.test(sandboxLog)) throw new Error("sandbox did not report fetch attempt");
  if (!/(MITM_REQUEST|MITM_RESPONSE|TRANSFORM_OK)/.test(egressLog)) {
    throw new Error("egress log does not show MITM transform event");
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
  log(`  sandbox: ${sandboxUrl}`);
  log(`  egress viewer: ${egressViewerUrl}`);
  log(`Artifacts: ${config.artifactDir}`);
  log("Tail egress log live:");
  log(
    `  doppler run --config dev -- pnpm --filter fly-test tail:egress-log ${config.app} egress-proxy`,
  );
  log("Destroy when done:");
  log(
    `  doppler run --config dev -- sh -lc 'export FLY_API_TOKEN="$FLY_API_KEY"; flyctl apps destroy ${config.app} -y'`,
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
