#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_CONFIG_PATH = "fly-test/topology.json";
const DEFAULT_FLY_API_HOST = "https://api.machines.dev";

type JsonRecord = Record<string, unknown>;

type TopologyMachine = {
  name: string;
  region: string;
};

type TopologyConfig = {
  appName: string;
  orgSlug: string;
  network?: string;
  image: string;
  internalPort: number;
  healthCheckPath?: string;
  env?: Record<string, string>;
  machines: TopologyMachine[];
};

type ExistingMachine = {
  id: string;
  name: string;
  region?: string;
  state?: string;
};

class FlyApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function usage(): string {
  return [
    "Usage:",
    "  pnpm tsx fly-test/apply-topology.ts [--config fly-test/topology.json] [--dry-run]",
    "",
    "Required env:",
    "  FLY_API_KEY",
    "",
    "Optional env:",
    "  FLY_API_HOST (default: https://api.machines.dev)",
  ].join("\n");
}

function parseArgs(argv: string[]): { configPath: string; dryRun: boolean; help: boolean } {
  let configPath = DEFAULT_CONFIG_PATH;
  let dryRun = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--config") {
      const next = argv[index + 1];
      if (!next || next.startsWith("-")) {
        throw new Error("--config requires a path");
      }
      configPath = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  return { configPath, dryRun, help };
}

function readTopologyConfig(configPath: string): TopologyConfig {
  const absolutePath = resolve(configPath);
  const raw = readFileSync(absolutePath, "utf8");
  const parsed: unknown = JSON.parse(raw);

  if (!isJsonRecord(parsed)) {
    throw new Error("Config file must be a JSON object");
  }

  const appName = parsed["appName"];
  const orgSlug = parsed["orgSlug"];
  const image = parsed["image"];
  const internalPort = parsed["internalPort"];
  const machines = parsed["machines"];

  if (typeof appName !== "string" || appName.length === 0) {
    throw new Error("config.appName must be a non-empty string");
  }
  if (typeof orgSlug !== "string" || orgSlug.length === 0) {
    throw new Error("config.orgSlug must be a non-empty string");
  }
  if (typeof image !== "string" || image.length === 0) {
    throw new Error("config.image must be a non-empty string");
  }
  if (typeof internalPort !== "number" || !Number.isInteger(internalPort)) {
    throw new Error("config.internalPort must be an integer");
  }
  if (!Array.isArray(machines) || machines.length === 0) {
    throw new Error("config.machines must be a non-empty array");
  }

  const parsedMachines: TopologyMachine[] = [];
  for (const machine of machines) {
    if (!isJsonRecord(machine)) {
      throw new Error("Each machine must be an object");
    }
    const name = machine["name"];
    const region = machine["region"];
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("Each machine.name must be a non-empty string");
    }
    if (typeof region !== "string" || region.length === 0) {
      throw new Error("Each machine.region must be a non-empty string");
    }
    parsedMachines.push({ name, region });
  }

  const network = parsed["network"];
  if (network !== undefined && typeof network !== "string") {
    throw new Error("config.network must be a string when set");
  }

  const healthCheckPath = parsed["healthCheckPath"];
  if (healthCheckPath !== undefined && typeof healthCheckPath !== "string") {
    throw new Error("config.healthCheckPath must be a string when set");
  }

  let env: Record<string, string> | undefined;
  if (parsed["env"] !== undefined) {
    if (!isJsonRecord(parsed["env"])) {
      throw new Error("config.env must be an object when set");
    }
    env = {};
    for (const [key, value] of Object.entries(parsed["env"])) {
      if (typeof value !== "string") {
        throw new Error(`config.env.${key} must be a string`);
      }
      env[key] = value;
    }
  }

  return {
    appName,
    orgSlug,
    network,
    image,
    internalPort,
    healthCheckPath,
    env,
    machines: parsedMachines,
  };
}

async function flyRequest(
  token: string,
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
): Promise<unknown> {
  const flyApiHost = process.env.FLY_API_HOST ?? DEFAULT_FLY_API_HOST;
  const response = await fetch(`${flyApiHost}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new FlyApiError(
      `Fly API request failed: ${init.method ?? "GET"} ${path}`,
      response.status,
      text,
    );
  }

  if (text.length === 0) return {};

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function parseExistingMachine(value: unknown): ExistingMachine | null {
  if (!isJsonRecord(value)) return null;

  const id = value["id"];
  const name = value["name"];

  if (typeof id !== "string" || typeof name !== "string") return null;

  const region = typeof value["region"] === "string" ? value["region"] : undefined;
  const state = typeof value["state"] === "string" ? value["state"] : undefined;

  return { id, name, region, state };
}

function parseMachineList(payload: unknown): ExistingMachine[] {
  if (Array.isArray(payload)) {
    return payload.map((value) => parseExistingMachine(value)).filter((value) => value !== null);
  }

  if (isJsonRecord(payload) && Array.isArray(payload["machines"])) {
    return payload["machines"]
      .map((value) => parseExistingMachine(value))
      .filter((value) => value !== null);
  }

  throw new Error("Unexpected Fly API list-machines response");
}

async function ensureApp(token: string, config: TopologyConfig, dryRun: boolean): Promise<boolean> {
  try {
    await flyRequest(token, `/v1/apps/${config.appName}`);
    console.log(`App exists: ${config.appName}`);
    return true;
  } catch (error) {
    if (!(error instanceof FlyApiError) || error.status !== 404) {
      throw error;
    }
  }

  if (dryRun) {
    console.log(`[dry-run] Would create app ${config.appName} in org ${config.orgSlug}`);
    return false;
  }

  const payload: JsonRecord = {
    app_name: config.appName,
    org_slug: config.orgSlug,
  };
  if (config.network) payload["network"] = config.network;

  await flyRequest(token, "/v1/apps", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  console.log(`Created app: ${config.appName}`);
  return true;
}

function buildCreateMachinePayload(config: TopologyConfig, machine: TopologyMachine): JsonRecord {
  return {
    name: machine.name,
    region: machine.region,
    config: {
      image: config.image,
      restart: { policy: "always" },
      env: config.env ?? {},
      guest: {
        cpu_kind: "shared",
        cpus: 1,
        memory_mb: 256,
      },
      services: [
        {
          protocol: "tcp",
          internal_port: config.internalPort,
          ports: [
            { port: 80, handlers: ["http"] },
            { port: 443, handlers: ["tls", "http"] },
          ],
        },
      ],
      checks: {
        alive: {
          type: "http",
          port: config.internalPort,
          method: "GET",
          path: config.healthCheckPath ?? "/",
          interval: "15s",
          timeout: "10s",
        },
      },
    },
  };
}

async function applyTopology(
  config: TopologyConfig,
  token: string,
  dryRun: boolean,
): Promise<void> {
  const appExists = await ensureApp(token, config, dryRun);

  if (!appExists) {
    for (const machine of config.machines) {
      console.log(`[dry-run] Would create machine ${machine.name} in ${machine.region}`);
    }
    console.log("");
    console.log(`Done. created=0, skipped=0, totalDesired=${config.machines.length}`);
    return;
  }

  const machineListPayload = await flyRequest(token, `/v1/apps/${config.appName}/machines`);
  const existingMachines = parseMachineList(machineListPayload);
  const existingByName = new Map(existingMachines.map((machine) => [machine.name, machine]));

  let createdCount = 0;
  let skippedCount = 0;

  for (const machine of config.machines) {
    const existing = existingByName.get(machine.name);
    if (existing) {
      skippedCount += 1;
      console.log(
        `Skip existing machine: ${machine.name} (${existing.id}, ${existing.region ?? "unknown"})`,
      );
      continue;
    }

    const payload = buildCreateMachinePayload(config, machine);
    if (dryRun) {
      console.log(`[dry-run] Would create machine ${machine.name} in ${machine.region}`);
      continue;
    }

    const response = await flyRequest(token, `/v1/apps/${config.appName}/machines`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const created = parseExistingMachine(response);
    createdCount += 1;
    if (created) {
      console.log(
        `Created machine: ${created.name} (${created.id}) in ${created.region ?? machine.region}`,
      );
      continue;
    }
    console.log(`Created machine: ${machine.name} in ${machine.region}`);
  }

  console.log("");
  console.log(
    `Done. created=${createdCount}, skipped=${skippedCount}, totalDesired=${config.machines.length}`,
  );
  console.log("If this is a brand-new app, allocate a public IP once:");
  console.log(`  fly ips allocate-v4 -a ${config.appName}`);
}

async function main(): Promise<void> {
  const { configPath, dryRun, help } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(usage());
    return;
  }

  const token = process.env.FLY_API_KEY;
  if (!token || token.length === 0) {
    throw new Error("Missing FLY_API_KEY");
  }

  const config = readTopologyConfig(configPath);

  console.log(`Config: ${resolve(configPath)}`);
  console.log(`Fly host: ${process.env.FLY_API_HOST ?? DEFAULT_FLY_API_HOST}`);
  console.log(`App: ${config.appName}`);
  console.log(`Dry run: ${dryRun ? "yes" : "no"}`);
  console.log("");

  await applyTopology(config, token, dryRun);
}

void main().catch((error: unknown) => {
  if (error instanceof FlyApiError) {
    console.error(error.message);
    console.error(`status=${error.status}`);
    console.error(error.body);
    process.exit(1);
  }
  if (error instanceof Error) {
    console.error(error.message);
    process.exit(1);
  }
  console.error("Unknown error");
  process.exit(1);
});
