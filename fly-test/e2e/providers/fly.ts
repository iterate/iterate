import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand, sleep, urlEncodedForm } from "../run-observability-lib.ts";
import type { FetchPayload, ObservabilityProvider, ProviderInit } from "./types.ts";

type Machine = {
  id: string;
  name: string;
  private_ip?: string;
};

function proxyHostForIp(ip: string): string {
  if (ip.includes(":")) return `[${ip}]`;
  return ip;
}

function readImageRef(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").trim();
}

function resolveImageRef(flyDir: string, envName: string, cacheName: string): string {
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const fromCache = readImageRef(join(flyDir, ".cache", cacheName));
  if (fromCache.length > 0) return fromCache;

  throw new Error(
    `Missing ${envName}. Build images first: doppler run --config dev -- bash ${join(flyDir, "scripts", "build-fly-images.sh")}`,
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
}

function listMachines(app: string, env: NodeJS.ProcessEnv): Machine[] {
  const result = runCommand("flyctl", ["machine", "list", "-a", app, "--json"], { env });
  return JSON.parse(result.stdout) as Machine[];
}

function findMachineByName(machines: Machine[], name: string): Machine {
  const machine = machines.find((value) => value.name === name);
  if (!machine) throw new Error(`machine not found: ${name}`);
  return machine;
}

function machineExec(
  app: string,
  machineId: string,
  command: string,
  env: NodeJS.ProcessEnv,
  allowFailure = false,
): { stdout: string; stderr: string; exitCode: number } {
  const result = runCommand("flyctl", ["machine", "exec", machineId, command, "-a", app], {
    env,
    allowFailure: true,
  });
  const combined = `${result.stdout}${result.stderr}`.trimEnd();
  const match = combined.match(/\n?Exit code:\s*(\d+)\s*$/);
  const exitCode = match ? Number(match[1]) : result.status;
  const output = match ? combined.slice(0, match.index).trimEnd() : combined;
  if (!allowFailure && exitCode !== 0) {
    throw new Error(
      [
        `machine exec failed: app=${app} machine=${machineId}`,
        `command=${command}`,
        `exit_code=${exitCode}`,
        output.length > 0 ? `output:\n${output}` : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
    );
  }
  return {
    stdout: output,
    stderr: "",
    exitCode,
  };
}

function waitForHealth(
  app: string,
  machineId: string,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return (async () => {
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      const result = machineExec(app, machineId, command, env, true);
      if (result.exitCode === 0) return;
      await sleep(1000);
    }
    throw new Error(`health check failed for machine=${machineId}`);
  })();
}

export class FlyProvider implements ObservabilityProvider {
  readonly name = "fly" as const;

  private readonly app: string;
  private readonly org: string;
  private readonly region: string;
  private readonly egressImage: string;
  private readonly sandboxImage: string;
  private readonly cleanupOnExit: boolean;
  private readonly targetUrl: string;
  private readonly log: (line: string) => void;
  private readonly env: NodeJS.ProcessEnv;

  private appCreated = false;
  private egressMachineId = "";
  private sandboxMachineId = "";

  constructor(init: ProviderInit) {
    const flyApiKey = requireEnv("FLY_API_KEY");
    this.app = init.app;
    this.org = process.env["FLY_ORG"] ?? "iterate";
    this.region = process.env["FLY_REGION"] ?? "iad";
    this.egressImage = resolveImageRef(init.flyDir, "FLY_TEST_EGRESS_IMAGE", "egress-image.txt");
    this.sandboxImage = resolveImageRef(init.flyDir, "FLY_TEST_SANDBOX_IMAGE", "sandbox-image.txt");
    this.cleanupOnExit = init.cleanupOnExit;
    this.targetUrl = init.targetUrl;
    this.log = init.log;
    this.env = {
      ...process.env,
      FLY_API_TOKEN: flyApiKey,
    };
  }

  async up(): Promise<void> {
    runCommand("flyctl", ["version"]);

    this.log(`Creating fly app: ${this.app} (org=${this.org} region=${this.region})`);
    runCommand("flyctl", ["apps", "create", this.app, "-o", this.org, "-y"], {
      env: this.env,
    });
    this.appCreated = true;

    this.log(`Launching egress machine: image=${this.egressImage}`);
    runCommand(
      "flyctl",
      [
        "machine",
        "run",
        this.egressImage,
        "-a",
        this.app,
        "-r",
        this.region,
        "--name",
        "egress-proxy",
        "--restart",
        "always",
        "--detach",
        "--vm-memory",
        "1024",
      ],
      { env: this.env },
    );

    const egress = findMachineByName(listMachines(this.app, this.env), "egress-proxy");
    if (!egress.private_ip) throw new Error("egress private_ip missing");
    const egressProxyHost = proxyHostForIp(egress.private_ip);
    this.egressMachineId = egress.id;

    this.log(`Launching sandbox machine: image=${this.sandboxImage}`);
    runCommand(
      "flyctl",
      [
        "machine",
        "run",
        this.sandboxImage,
        "-a",
        this.app,
        "-r",
        this.region,
        "--name",
        "sandbox-ui",
        "--restart",
        "always",
        "--detach",
        "--vm-memory",
        "1024",
        "-e",
        `EGRESS_PROXY_HOST=${egressProxyHost}`,
        "-e",
        "EGRESS_MITM_PORT=18080",
        "-e",
        "EGRESS_VIEWER_PORT=18081",
        "-e",
        `DEFAULT_TARGET_URL=${this.targetUrl}`,
      ],
      { env: this.env },
    );

    const sandbox = findMachineByName(listMachines(this.app, this.env), "sandbox-ui");
    this.sandboxMachineId = sandbox.id;

    this.log(
      `Waiting for fly machine health: egress=${this.egressMachineId} sandbox=${this.sandboxMachineId}`,
    );
    await waitForHealth(
      this.app,
      this.egressMachineId,
      "curl -fsS --max-time 2 http://127.0.0.1:18081/healthz",
      this.env,
    );
    await waitForHealth(
      this.app,
      this.egressMachineId,
      "curl -fsS --max-time 2 http://127.0.0.1:18080/healthz",
      this.env,
    );
    await waitForHealth(
      this.app,
      this.sandboxMachineId,
      "curl -fsS --max-time 2 http://127.0.0.1:8080/healthz",
      this.env,
    );
  }

  async sandboxFetch(payload: FetchPayload): Promise<string> {
    if (!this.sandboxMachineId) throw new Error("sandbox machine not ready");

    const method = (payload.method ?? "GET").toUpperCase();
    const body = payload.body ?? "";
    const form = urlEncodedForm({
      url: payload.url,
      method,
      body,
    });

    const command = `curl -sS --max-time 75 --data '${form}' http://127.0.0.1:8080/api/fetch`;
    const result = machineExec(this.app, this.sandboxMachineId, command, this.env);
    return result.stdout;
  }

  async readSandboxLog(): Promise<string> {
    if (!this.sandboxMachineId) return "";
    const result = machineExec(
      this.app,
      this.sandboxMachineId,
      "cat /tmp/sandbox-ui.log",
      this.env,
      true,
    );
    return `${result.stdout}${result.stderr}`;
  }

  async readEgressLog(): Promise<string> {
    if (!this.egressMachineId) return "";
    const result = machineExec(
      this.app,
      this.egressMachineId,
      "cat /tmp/egress-proxy.log",
      this.env,
      true,
    );
    return `${result.stdout}${result.stderr}`;
  }

  async down(): Promise<void> {
    if (!this.appCreated) return;
    if (!this.cleanupOnExit) {
      this.log(
        `Fly cleanup disabled. Manual cleanup: doppler run --config dev -- sh -lc 'export FLY_API_TOKEN="$FLY_API_KEY"; flyctl apps destroy ${this.app} -y'`,
      );
      return;
    }

    runCommand("flyctl", ["apps", "destroy", this.app, "-y"], {
      env: this.env,
      allowFailure: true,
    });
    this.log(`Fly cleanup complete: app=${this.app}`);
  }
}
