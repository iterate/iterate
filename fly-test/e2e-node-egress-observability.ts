#!/usr/bin/env tsx
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  hostFromUrl,
  proxyHostForIp,
  urlEncodedForm,
} from "./e2e-node-egress-observability-lib.ts";

type Machine = {
  id: string;
  name: string;
  private_ip?: string;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  status: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mustHaveEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`Missing ${name} in env`);
  }
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
  return { stdout, stderr, status };
}

async function main(): Promise<void> {
  mustHaveEnv("FLY_API_KEY");
  run("flyctl", ["version"]);
  run("jq", ["--version"]);
  run("dig", ["+short", "example.com"]);

  const scriptDir = process.cwd().endsWith("/fly-test")
    ? process.cwd()
    : join(process.cwd(), "fly-test");
  const org = process.env["FLY_ORG"] ?? "iterate";
  const region = process.env["FLY_REGION"] ?? "iad";
  const targetUrl = process.env["TARGET_URL"] ?? "https://example.com/";
  const app = process.env["APP_NAME"] ?? `iterate-node-egress-obsv-${timestampTag()}`;
  const artifactDir = join(scriptDir, "proof-logs", app);
  mkdirSync(artifactDir, { recursive: true });

  const env = {
    ...process.env,
    FLY_API_TOKEN: mustHaveEnv("FLY_API_KEY"),
  };

  const summaryPath = join(artifactDir, "summary.txt");
  const log = (message: string): void => {
    process.stdout.write(`${message}\n`);
    execFileSync(
      "sh",
      ["-lc", `printf "%s\\n" "${escapeForShell(message)}" >> "${escapeForShell(summaryPath)}"`],
      {
        stdio: "inherit",
      },
    );
  };

  log(`Creating app: ${app} (org=${org} region=${region})`);
  const appCreate = run("flyctl", ["apps", "create", app, "-o", org, "-y"], { env });
  writeFileSync(join(artifactDir, "app-create.log"), `${appCreate.stdout}${appCreate.stderr}`);

  log("Launching egress proxy/viewer machine (node:24)");
  const egressRun = run(
    "flyctl",
    [
      "machine",
      "run",
      "node:24",
      "/bin/bash",
      "/proof/start-egress-node.sh",
      "-a",
      app,
      "-r",
      region,
      "--name",
      "egress-proxy",
      "--restart",
      "always",
      "--detach",
      "--file-local",
      `/proof/egress-proxy-and-viewer.mjs=${join(scriptDir, "egress-proxy-and-viewer.mjs")}`,
      "--file-local",
      `/proof/start-egress-node.sh=${join(scriptDir, "start-egress-node.sh")}`,
      "-e",
      `PROOF_REGION=${region}`,
    ],
    { env },
  );
  writeFileSync(
    join(artifactDir, "egress-machine-run.log"),
    `${egressRun.stdout}${egressRun.stderr}`,
  );

  const machinesAfterEgress = listMachines(app, env);
  const egress = machineByName(machinesAfterEgress, "egress-proxy");
  if (!egress.private_ip) throw new Error("egress machine private IP not found");
  const egressProxyHost = proxyHostForIp(egress.private_ip);
  writeFileSync(join(artifactDir, "egress-machine-id.txt"), `${egress.id}\n`);
  writeFileSync(join(artifactDir, "egress-machine-ip.txt"), `${egress.private_ip}\n`);
  log(
    `Egress machine: id=${egress.id} private_ip=${egress.private_ip} proxy_host=${egressProxyHost}`,
  );

  log("Launching sandbox machine (node:24) wired to egress proxy");
  const sandboxRun = run(
    "flyctl",
    [
      "machine",
      "run",
      "node:24",
      "/bin/bash",
      "/proof/start-sandbox-node.sh",
      "-a",
      app,
      "-r",
      region,
      "--name",
      "sandbox-ui",
      "--restart",
      "always",
      "--detach",
      "--file-local",
      `/proof/sandbox-ui.mjs=${join(scriptDir, "sandbox-ui.mjs")}`,
      "--file-local",
      `/proof/start-sandbox-node.sh=${join(scriptDir, "start-sandbox-node.sh")}`,
      "-e",
      `PROOF_REGION=${region}`,
      "-e",
      `EGRESS_PROXY_URL=http://${egressProxyHost}:18080`,
      "-e",
      `DEFAULT_TARGET_URL=${targetUrl}`,
    ],
    { env },
  );
  writeFileSync(
    join(artifactDir, "sandbox-machine-run.log"),
    `${sandboxRun.stdout}${sandboxRun.stderr}`,
  );

  const machinesAfterSandbox = listMachines(app, env);
  const sandbox = machineByName(machinesAfterSandbox, "sandbox-ui");
  writeFileSync(join(artifactDir, "sandbox-machine-id.txt"), `${sandbox.id}\n`);
  log(`Sandbox machine: id=${sandbox.id}`);

  log("Waiting for cloudflared tunnel URLs from both machines");
  const egressViewerUrl = await waitForMachineFileAsUrl(
    app,
    egress.id,
    "/tmp/egress-viewer-tunnel-url.txt",
    join(artifactDir, "egress-viewer-url.txt"),
    env,
  );
  const sandboxUrl = await waitForMachineFileAsUrl(
    app,
    sandbox.id,
    "/tmp/sandbox-tunnel-url.txt",
    join(artifactDir, "sandbox-url.txt"),
    env,
  );
  log(`Egress viewer URL: ${egressViewerUrl}`);
  log(`Sandbox URL: ${sandboxUrl}`);

  log("Checking both pages from host");
  await fetchUrlWithDnsFallback(
    egressViewerUrl,
    join(artifactDir, "egress-viewer-home.html"),
    join(artifactDir, "egress-viewer-home.stderr"),
  );
  await fetchUrlWithDnsFallback(
    sandboxUrl,
    join(artifactDir, "sandbox-home.html"),
    join(artifactDir, "sandbox-home.stderr"),
  );

  log(`Triggering outbound fetch via sandbox form: ${targetUrl}`);
  await postFormWithDnsFallback(
    `${sandboxUrl}/fetch`,
    urlEncodedForm({ url: targetUrl }),
    join(artifactDir, "sandbox-fetch-response.html"),
    join(artifactDir, "sandbox-fetch.stderr"),
  );

  log("Collecting logs from both machines");
  collectMachineFile(
    app,
    egress.id,
    "/tmp/egress-proxy.log",
    join(artifactDir, "egress-proxy.log"),
    env,
  );
  collectMachineFile(
    app,
    egress.id,
    "/tmp/egress-init.log",
    join(artifactDir, "egress-init.log"),
    env,
  );
  collectMachineFile(
    app,
    egress.id,
    "/tmp/egress-tunnel.log",
    join(artifactDir, "egress-tunnel.log"),
    env,
  );
  collectMachineFile(
    app,
    sandbox.id,
    "/tmp/sandbox-ui.log",
    join(artifactDir, "sandbox-ui.log"),
    env,
  );
  collectMachineFile(
    app,
    sandbox.id,
    "/tmp/sandbox-init.log",
    join(artifactDir, "sandbox-init.log"),
    env,
  );
  collectMachineFile(
    app,
    sandbox.id,
    "/tmp/sandbox-tunnel.log",
    join(artifactDir, "sandbox-tunnel.log"),
    env,
  );

  const sandboxLog = readFileSafe(join(artifactDir, "sandbox-ui.log"));
  const egressLog = readFileSafe(join(artifactDir, "egress-proxy.log"));
  if (!/FETCH_(OK|ERROR)/.test(sandboxLog)) throw new Error("sandbox did not report fetch attempt");
  if (!/(HTTP|CONNECT_OPEN|CONNECT_CLOSE)/.test(egressLog)) {
    throw new Error("egress proxy log does not show outbound proxy event");
  }

  log("SUCCESS");
  log("Open side-by-side:");
  log(`  sandbox: ${sandboxUrl}`);
  log(`  egress viewer: ${egressViewerUrl}`);
  log(`Artifacts: ${artifactDir}`);
  log("Tail egress log live:");
  log(`  doppler run --config dev -- bash fly-test/tail-egress-log.sh ${app} egress-proxy`);
  log("Destroy when done:");
  log(
    `  doppler run --config dev -- sh -lc 'export FLY_API_TOKEN="$FLY_API_KEY"; flyctl apps destroy ${app} -y'`,
  );
}

function timestampTag(): string {
  const date = new Date();
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${two(date.getMonth() + 1)}${two(date.getDate())}${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function machineByName(machines: Machine[], name: string): Machine {
  const machine = machines.find((item) => item.name === name);
  if (!machine) throw new Error(`machine not found: ${name}`);
  return machine;
}

function listMachines(app: string, env: NodeJS.ProcessEnv): Machine[] {
  const result = run("flyctl", ["machine", "list", "-a", app, "--json"], { env });
  return JSON.parse(result.stdout) as Machine[];
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

async function waitForMachineFileAsUrl(
  app: string,
  machineId: string,
  remoteFile: string,
  outputFile: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  for (let attempt = 1; attempt <= 150; attempt += 1) {
    const result = run("flyctl", ["machine", "exec", machineId, `cat ${remoteFile}`, "-a", app], {
      env,
      allowFailure: true,
    });
    const combined = `${result.stdout}${result.stderr}`.trim();
    const lines = combined.split(/\r?\n/).filter((line) => line.length > 0);
    const maybe = lines.find((line) => /^https:\/\/[-a-z0-9]+\.trycloudflare\.com$/.test(line));
    if (result.status === 0 && maybe) {
      writeFileSync(outputFile, `${maybe}\n`);
      return maybe;
    }
    await sleep(2000);
  }
  throw new Error(`machine file url not ready: machine=${machineId} file=${remoteFile}`);
}

async function fetchUrlWithDnsFallback(
  url: string,
  outputFile: string,
  stderrFile: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const result = run("curl", ["-fsS", "--max-time", "25", url], { allowFailure: true });
    if (result.status === 0) {
      writeFileSync(outputFile, result.stdout);
      writeFileSync(stderrFile, result.stderr);
      return;
    }
    await sleep(1000);
  }

  const host = hostFromUrl(url).split(":")[0];
  const dig = run("dig", ["+short", host, "@1.1.1.1"], { allowFailure: true });
  const ip = dig.stdout
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
      writeFileSync(outputFile, result.stdout);
      writeFileSync(stderrFile, result.stderr);
      return;
    }
    await sleep(1000);
  }
  throw new Error(`failed to fetch URL after fallback: ${url}`);
}

async function postFormWithDnsFallback(
  url: string,
  data: string,
  outputFile: string,
  stderrFile: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const result = run("curl", ["-fsS", "--max-time", "30", "--data", data, url], {
      allowFailure: true,
    });
    if (result.status === 0) {
      writeFileSync(outputFile, result.stdout);
      writeFileSync(stderrFile, result.stderr);
      return;
    }
    await sleep(1000);
  }

  const host = hostFromUrl(url).split(":")[0];
  const dig = run("dig", ["+short", host, "@1.1.1.1"], { allowFailure: true });
  const ip = dig.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!ip) throw new Error(`DNS lookup failed for ${host}`);

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const result = run(
      "curl",
      ["-fsS", "--max-time", "30", "--resolve", `${host}:443:${ip}`, "--data", data, url],
      { allowFailure: true },
    );
    if (result.status === 0) {
      writeFileSync(outputFile, result.stdout);
      writeFileSync(stderrFile, result.stderr);
      return;
    }
    await sleep(1000);
  }
  throw new Error(`failed to post form after fallback: ${url}`);
}

function escapeForShell(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
