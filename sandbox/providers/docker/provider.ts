/**
 * Docker Provider Implementation
 *
 * Creates sandbox containers via Docker API (not docker-compose).
 * Supports both development (with host repo sync) and test environments.
 */

import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import {
  Sandbox,
  SandboxProvider,
  type ProviderState,
  type CreateSandboxOptions,
  type SandboxInfo,
  type SnapshotInfo,
} from "../types.ts";
import {
  dockerApi,
  execInContainer,
  sanitizeEnvVars,
  rewriteLocalhost,
  type DockerInspect,
} from "./api.ts";
import { getGitInfo, resolveBaseImage, type DockerGitInfo } from "./utils.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(__dirname, "../../..");

const PIDNAP_PORT = 9876;
const LIFECYCLE_TIMEOUT_MS = 120_000;

// Port definitions matching backend/daemons.ts
const DAEMON_PORTS = [
  { id: "iterate-daemon", internalPort: 3000 },
  { id: "iterate-daemon-server", internalPort: 3001 },
  { id: "opencode", internalPort: 4096 },
] as const;

/**
 * Zod schema for Docker provider environment variables.
 */
const DockerEnv = z.object({
  DOCKER_IMAGE_NAME: z.string().optional(),
  DOCKER_COMPOSE_PROJECT_NAME: z.string().optional(),
  DOCKER_GIT_REPO_ROOT: z.string().optional(),
  DOCKER_GIT_GITDIR: z.string().optional(),
  DOCKER_GIT_COMMON_DIR: z.string().optional(),
  DOCKER_SYNC_FROM_HOST_REPO: z
    .string()
    .transform((v) => v === "true")
    .default(false),
});

type DockerEnv = z.infer<typeof DockerEnv>;

/**
 * Docker sandbox implementation.
 * Extends the abstract Sandbox class with Docker-specific functionality.
 */
export class DockerSandbox extends Sandbox {
  readonly providerId: string;
  readonly type = "docker" as const;

  private ports: Record<number, number>;
  private readonly internalPorts: number[];

  constructor(containerId: string, ports: Record<number, number>, internalPorts: number[]) {
    super();
    this.providerId = containerId;
    this.ports = ports;
    this.internalPorts = internalPorts;
  }

  // === Core abstraction ===

  async getFetch(opts: { port: number }): Promise<typeof fetch> {
    const baseUrl = await this.getPreviewUrl(opts);
    return (input: string | Request | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? `${baseUrl}${input}` : input;
      return fetch(url, init);
    };
  }

  private async ensurePortsResolved(): Promise<void> {
    if (Object.keys(this.ports).length === 0) {
      this.ports = await resolveHostPorts(this.providerId, this.internalPorts);
    }
  }

  async getPreviewUrl(opts: { port: number }): Promise<string> {
    await this.ensurePortsResolved();
    const hostPort = this.ports[opts.port];
    if (!hostPort) {
      throw new Error(`No host port mapped for ${opts.port}`);
    }
    return `http://127.0.0.1:${hostPort}`;
  }

  // === Lifecycle ===

  async exec(cmd: string[]): Promise<string> {
    return execInContainer(this.providerId, cmd);
  }

  async getState(): Promise<ProviderState> {
    try {
      const inspect = await dockerApi<DockerInspect>("GET", `/containers/${this.providerId}/json`);
      return {
        state: inspect.State?.Status ?? "unknown",
        errorReason: inspect.State?.Error,
      };
    } catch (err) {
      return {
        state: "error",
        errorReason: String(err),
      };
    }
  }

  async start(): Promise<void> {
    this.resetClientCaches();
    await withTimeout(
      dockerApi("POST", `/containers/${this.providerId}/start`, {}),
      LIFECYCLE_TIMEOUT_MS,
      "start",
    );
    this.ports = await resolveHostPorts(this.providerId, this.internalPorts);
  }

  async stop(): Promise<void> {
    try {
      await dockerApi("POST", `/containers/${this.providerId}/stop`, {});
    } catch {
      // Container might already be stopped
    }
  }

  async restart(): Promise<void> {
    this.resetClientCaches();
    await withTimeout(
      dockerApi("POST", `/containers/${this.providerId}/restart`, {}),
      LIFECYCLE_TIMEOUT_MS,
      "restart",
    );
    this.ports = await resolveHostPorts(this.providerId, this.internalPorts);
  }

  async delete(): Promise<void> {
    try {
      await dockerApi("DELETE", `/containers/${this.providerId}?force=true`, undefined);
    } catch {
      // Best effort cleanup
    }
  }
}

/**
 * Docker provider implementation.
 * Extends the abstract SandboxProvider class.
 */
export class DockerProvider extends SandboxProvider {
  protected readonly envSchema = DockerEnv;
  declare protected readonly env: DockerEnv;

  readonly type = "docker" as const;

  private readonly repoRoot: string;
  private readonly gitInfo: DockerGitInfo | undefined;

  constructor(rawEnv: Record<string, string | undefined>) {
    super(rawEnv);
    this.parseEnv(rawEnv); // Must call after super() since envSchema is a field declaration
    this.repoRoot = this.env.DOCKER_GIT_REPO_ROOT ?? DEFAULT_REPO_ROOT;
    this.gitInfo = this.env.DOCKER_SYNC_FROM_HOST_REPO ? getGitInfo(this.repoRoot) : undefined;
  }

  get defaultSnapshotId(): string {
    return resolveBaseImage(this.repoRoot, this.env.DOCKER_IMAGE_NAME);
  }

  async create(opts: CreateSandboxOptions): Promise<DockerSandbox> {
    const imageName = resolveBaseImage(this.repoRoot, opts.snapshotId ?? this.defaultSnapshotId);

    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    const exposedPorts: Record<string, object> = {};

    DAEMON_PORTS.forEach((daemon) => {
      const internalPortKey = `${daemon.internalPort}/tcp`;
      portBindings[internalPortKey] = [{ HostPort: "0" }];
      exposedPorts[internalPortKey] = {};
    });

    portBindings[`${PIDNAP_PORT}/tcp`] = [{ HostPort: "0" }];
    exposedPorts[`${PIDNAP_PORT}/tcp`] = {};

    const suffix = randomBytes(4).toString("hex");
    const sanitizedName = (opts.id ?? opts.name).replace(/[^a-zA-Z0-9_.-]/g, "-");
    const containerName = `sandbox-${sanitizedName}-${suffix}`.slice(0, 63);

    const binds: string[] = [];
    if (this.gitInfo) {
      binds.push(`${this.gitInfo.repoRoot}:/host/repo-checkout:ro`);
      binds.push(`${this.gitInfo.gitDir}:/host/gitdir:ro`);
      binds.push(`${this.gitInfo.commonDir}:/host/commondir:ro`);
    }

    const dockerEnv: Record<string, string> = {
      ITERATE_DEV: "true",
      ...(this.gitInfo ? { DOCKER_SYNC_FROM_HOST_REPO: "true" } : {}),
    };

    const envArray = sanitizeEnvVars(dockerEnv);

    const iterateEnv: Record<string, string> = { ...opts.envVars };
    if (iterateEnv.ITERATE_OS_BASE_URL) {
      iterateEnv.ITERATE_OS_BASE_URL = rewriteLocalhost(iterateEnv.ITERATE_OS_BASE_URL);
    }
    if (iterateEnv.ITERATE_EGRESS_PROXY_URL) {
      iterateEnv.ITERATE_EGRESS_PROXY_URL = rewriteLocalhost(iterateEnv.ITERATE_EGRESS_PROXY_URL);
    }

    const labels: Record<string, string> = {
      "com.iterate.sandbox": "true",
      "com.iterate.container_name": containerName,
      "com.iterate.machine_type": "docker",
    };

    if (this.env.DOCKER_COMPOSE_PROJECT_NAME) {
      labels["com.docker.compose.project"] = this.env.DOCKER_COMPOSE_PROJECT_NAME;
      labels["com.docker.compose.service"] = `sandbox--${containerName}`;
      labels["com.docker.compose.oneoff"] = "False";
    }

    const hostConfig: Record<string, unknown> = {
      PortBindings: portBindings,
      Binds: binds,
      ExtraHosts: ["host.docker.internal:host-gateway"],
    };

    const createResponse = await dockerApi<{ Id: string }>(
      "POST",
      `/containers/create?name=${encodeURIComponent(containerName)}`,
      {
        Image: imageName,
        ...(opts.command ? { Cmd: opts.command } : {}),
        Env: envArray,
        ExposedPorts: exposedPorts,
        HostConfig: hostConfig,
        Labels: labels,
      },
    );

    const containerId = createResponse.Id;
    await dockerApi("POST", `/containers/${containerId}/start`, {});

    const internalPorts = [...DAEMON_PORTS.map((daemon) => daemon.internalPort), PIDNAP_PORT];
    const ports = await resolveHostPorts(containerId, internalPorts);
    const sandbox = new DockerSandbox(containerId, ports, internalPorts);
    const maxWaitMs = 30000;

    if (opts.command) {
      const start = Date.now();
      while (Date.now() - start < maxWaitMs) {
        try {
          await sandbox.exec(["true"]);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      await waitForEntrypointSignal(sandbox, maxWaitMs);

      if (this.gitInfo?.commit) {
        // Worktree sync is occasionally still settling immediately after the signal.
        // A short fixed delay has proven more stable than extra polling here.
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    if (Object.keys(iterateEnv).length > 0) {
      if (!opts.command) {
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
          try {
            await sandbox.exec(["curl", "-sf", "http://localhost:9876/rpc/health"]);
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 500));
          }
        }

        await waitForEntrypointSignal(sandbox, maxWaitMs);

        const syncStart = Date.now();
        while (Date.now() - syncStart < maxWaitMs) {
          const running = await sandbox.exec([
            "bash",
            "-c",
            "pgrep -f 'sync-home-skeleton.sh|sync-repo-from-host.sh' || true",
          ]);
          if (!running.trim()) break;
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      for (const [key, value] of Object.entries(iterateEnv)) {
        if (value === undefined) continue;
        const encoded = Buffer.from(`export ${key}="${value}"\n`).toString("base64");
        await sandbox.exec(["sh", "-c", `echo '${encoded}' | base64 -d >> ~/.iterate/.env`]);
      }
    }

    return sandbox;
  }

  get(providerId: string): DockerSandbox | null {
    // For Docker, we can't easily check if container exists without API call
    // Return a handle and let operations fail if container doesn't exist
    const internalPorts = [...DAEMON_PORTS.map((d) => d.internalPort), PIDNAP_PORT];
    // Ports will be resolved lazily or on start/restart
    return new DockerSandbox(providerId, {}, internalPorts);
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    const containers = await dockerApi<
      Array<{
        Id: string;
        Names: string[];
        State: string;
        Labels: Record<string, string>;
      }>
    >(
      "GET",
      `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: ["com.iterate.sandbox=true"] }))}`,
    );

    return containers.map((c) => ({
      type: "docker" as const,
      providerId: c.Id,
      name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
      state: c.State,
    }));
  }

  async listSnapshots(): Promise<SnapshotInfo[]> {
    const images = await dockerApi<
      Array<{
        Id: string;
        RepoTags: string[];
        Created: number;
        Labels: Record<string, string>;
      }>
    >("GET", `/images/json`);

    // Filter to sandbox-related images
    return images
      .filter((img) =>
        img.RepoTags?.some((tag) => tag.includes("sandbox") || tag.includes("iterate")),
      )
      .map((img) => ({
        type: "docker" as const,
        snapshotId: img.RepoTags?.[0] ?? img.Id,
        name: img.RepoTags?.[0],
        createdAt: new Date(img.Created * 1000),
      }));
  }
}

// =============================================================================
// Helper functions
// =============================================================================

async function resolveHostPorts(
  containerId: string,
  internalPorts: number[],
): Promise<Record<number, number>> {
  const inspect = await dockerApi<DockerInspect>("GET", `/containers/${containerId}/json`);
  const ports = inspect.NetworkSettings?.Ports ?? {};
  const resolved: Record<number, number> = {};
  for (const internalPort of internalPorts) {
    const key = `${internalPort}/tcp`;
    const bindings = ports[key];
    const hostPortRaw = Array.isArray(bindings) ? bindings[0]?.HostPort : undefined;
    if (!hostPortRaw) {
      throw new Error(`No host port mapped for ${key}`);
    }
    const hostPort = Number(hostPortRaw);
    if (Number.isNaN(hostPort)) {
      throw new Error(`Invalid host port for ${key}: ${hostPortRaw}`);
    }
    resolved[internalPort] = hostPort;
  }
  return resolved;
}

async function waitForEntrypointSignal(sandbox: Sandbox, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await sandbox.exec(["test", "-f", "/tmp/reached-entrypoint"]);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("Timeout waiting for /tmp/reached-entrypoint");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Docker lifecycle operation timed out: ${operation} (${timeoutMs}ms)`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
