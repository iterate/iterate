import { generateKeyPairSync } from "node:crypto";
import { z } from "zod/v4";
import { decodeFlyProviderId, type FlySandbox } from "./provider.ts";

const FLY_API_BASE = "https://api.machines.dev";
const WG_PORT = 51820;
const DEFAULT_FLY_ORG = "iterate";
const MAX_WAIT_TIMEOUT_SECONDS = 60;

const SharedEgressEnv = z.object({
  FLY_API_TOKEN: z.string(),
  FLY_ORG: z.string().default(DEFAULT_FLY_ORG),
  FLY_REGION: z.string().default("ord"),
  FLY_EGRESS_IMAGE: z.string().default("ubuntu:24.04"),
});

type SharedEgressEnv = z.infer<typeof SharedEgressEnv>;

function withFlyToken(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (env.FLY_API_TOKEN || !env.FLY_API_KEY) {
    return env;
  }
  return {
    ...env,
    FLY_API_TOKEN: env.FLY_API_KEY,
  };
}

type SandboxRef = FlySandbox | { appName: string; machineId: string } | { providerId: string };

export interface SharedEgressHandle {
  appName: string;
  machineId: string;
  network: string;
  publicKey: string;
  privateIp: string;
}

export interface ProvisionSharedEgressResult {
  egress: SharedEgressHandle;
  sandboxPublicKey: string;
  tunnelIp: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("already exists") || message.includes("has already been taken");
}

function generateWgKeyPair(): { privateKey: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  return {
    privateKey: privateKey.subarray(privateKey.length - 32).toString("base64"),
    publicKey: publicKey.subarray(publicKey.length - 32).toString("base64"),
  };
}

function resolveSandboxRef(input: SandboxRef): { appName: string; machineId: string } {
  if ("appName" in input && "machineId" in input) {
    return { appName: input.appName, machineId: input.machineId };
  }

  const parsed = decodeFlyProviderId(input.providerId);
  if (!parsed) throw new Error(`Invalid fly provider id: ${input.providerId}`);
  return parsed;
}

async function flyApi<T = unknown>(
  env: SharedEgressEnv,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${FLY_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.FLY_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
  }

  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

async function waitForState(
  env: SharedEgressEnv,
  appName: string,
  machineId: string,
  state: string,
  timeoutSeconds = 180,
): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    const remainingSeconds = timeoutSeconds - elapsedSeconds;
    if (remainingSeconds <= 0) {
      throw new Error(`Timed out waiting for Fly machine ${machineId} to reach '${state}'`);
    }

    const stepTimeoutSeconds = Math.max(1, Math.min(remainingSeconds, MAX_WAIT_TIMEOUT_SECONDS));
    try {
      await flyApi(
        env,
        "GET",
        `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/wait?state=${encodeURIComponent(state)}&timeout=${stepTimeoutSeconds}`,
      );
      return;
    } catch (error) {
      const message = String(error).toLowerCase();
      if (!message.includes("deadline_exceeded") && !message.includes("(408)")) {
        throw error;
      }
    }
  }
}

async function execMachine(
  env: SharedEgressEnv,
  appName: string,
  machineId: string,
  cmd: string[],
): Promise<string> {
  if (cmd.length === 0) {
    throw new Error("Fly exec requires at least one command token");
  }
  const payload = await flyApi<unknown>(
    env,
    "POST",
    `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/exec`,
    {
      command: cmd,
      timeout: 90,
    },
  );

  const result = asRecord(payload);
  const exitCode = typeof result.exit_code === "number" ? result.exit_code : 0;
  const stdout = asString(result.stdout) ?? "";
  const stderr = asString(result.stderr) ?? "";

  if (exitCode !== 0) {
    throw new Error(`Fly exec failed (exit=${exitCode}): ${stderr || stdout}`);
  }

  return stdout || stderr;
}

function getPrivateIp(machine: unknown): string {
  const value = asString(asRecord(machine).private_ip);
  if (!value) throw new Error("Machine does not have private_ip");
  return value;
}

async function ensureSharedEgressMachine(
  env: SharedEgressEnv,
  network: string,
  appName: string,
): Promise<SharedEgressHandle> {
  try {
    await flyApi(env, "POST", "/v1/apps", {
      app_name: appName,
      org_slug: env.FLY_ORG,
      network,
    });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }

  const machines = await flyApi<unknown[]>(
    env,
    "GET",
    `/v1/apps/${encodeURIComponent(appName)}/machines`,
  );

  const existing = machines.find((machine) => {
    const metadata = asRecord(asRecord(asRecord(machine).config).metadata);
    return metadata["com.iterate.role"] === "egress";
  });

  if (existing) {
    const machineId = asString(asRecord(existing).id);
    if (!machineId) throw new Error("Existing egress machine is missing id");

    const metadata = asRecord(asRecord(asRecord(existing).config).metadata);
    const publicKey = asString(metadata["com.iterate.wg_public_key"]);
    if (!publicKey) throw new Error("Existing egress machine is missing WireGuard public key");

    return {
      appName,
      machineId,
      network,
      publicKey,
      privateIp: getPrivateIp(existing),
    };
  }

  const keys = generateWgKeyPair();
  const initScript = `#!/bin/bash
set -e
apt-get update -qq && apt-get install -y -qq wireguard-tools iptables iproute2 >/dev/null 2>&1
sysctl -w net.ipv4.ip_forward=1 >/dev/null
mkdir -p /etc/wireguard
cat > /etc/wireguard/wg0.conf << 'WGCONF'
[Interface]
Address = 10.99.0.1/24
ListenPort = ${WG_PORT}
PrivateKey = ${keys.privateKey}
MTU = 1280
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -A FORWARD -o wg0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT; iptables -t nat -A POSTROUTING -s 10.99.0.0/24 -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -D FORWARD -o wg0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT; iptables -t nat -D POSTROUTING -s 10.99.0.0/24 -o eth0 -j MASQUERADE
WGCONF
wg-quick up wg0
sleep infinity
`;

  const created = await flyApi<unknown>(
    env,
    "POST",
    `/v1/apps/${encodeURIComponent(appName)}/machines`,
    {
      name: "shared-egress",
      region: env.FLY_REGION,
      skip_launch: false,
      config: {
        image: env.FLY_EGRESS_IMAGE,
        guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
        restart: { policy: "always" },
        metadata: {
          "com.iterate.role": "egress",
          "com.iterate.wg_public_key": keys.publicKey,
          "com.iterate.network": network,
        },
        init: { exec: ["/bin/bash", "-lc", initScript] },
      },
    },
  );

  const machineId = asString(asRecord(created).id);
  if (!machineId) throw new Error("Failed to create egress machine");
  await waitForState(env, appName, machineId, "started", 240);
  const machine = await flyApi<unknown>(
    env,
    "GET",
    `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`,
  );

  return {
    appName,
    machineId,
    network,
    publicKey: keys.publicKey,
    privateIp: getPrivateIp(machine),
  };
}

export async function provisionSharedEgressAndAttach(opts: {
  env: Record<string, string | undefined>;
  network: string;
  egressAppName: string;
  sandbox: SandboxRef;
  tunnelIp: string;
}): Promise<ProvisionSharedEgressResult> {
  const env = SharedEgressEnv.parse(withFlyToken(opts.env));
  const sandbox = resolveSandboxRef(opts.sandbox);
  const egress = await ensureSharedEgressMachine(env, opts.network, opts.egressAppName);

  const sandboxKeys = generateWgKeyPair();
  const sandboxConfig = `#!/bin/bash
set -e
apt-get update -qq && apt-get install -y -qq wireguard-tools iproute2 >/dev/null 2>&1
mkdir -p /etc/wireguard
cat > /etc/wireguard/wg0.conf << 'WGCONF'
[Interface]
Address = ${opts.tunnelIp}/32
PrivateKey = ${sandboxKeys.privateKey}
MTU = 1280
[Peer]
PublicKey = ${egress.publicKey}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = [${egress.privateIp}]:${WG_PORT}
PersistentKeepalive = 25
WGCONF
wg-quick down wg0 >/dev/null 2>&1 || true
wg-quick up wg0
`;

  await execMachine(env, sandbox.appName, sandbox.machineId, ["/bin/bash", "-lc", sandboxConfig]);
  await execMachine(env, egress.appName, egress.machineId, [
    "/bin/bash",
    "-lc",
    `wg set wg0 peer '${sandboxKeys.publicKey}' allowed-ips '${opts.tunnelIp}/32'`,
  ]);

  return {
    egress,
    sandboxPublicKey: sandboxKeys.publicKey,
    tunnelIp: opts.tunnelIp,
  };
}
