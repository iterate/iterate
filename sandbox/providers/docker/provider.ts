/**
 * Docker Provider Implementation
 *
 * Creates sandbox containers via Docker API (not docker-compose).
 * Supports both development (with host repo sync) and test environments.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import {
  Sandbox,
  SandboxProvider,
  type ProviderState,
  type CreateSandboxOptions,
  type SandboxInfo,
  type SnapshotInfo,
} from "../types.ts";
import { getPidnapClientForSandbox } from "../clients.ts";
import {
  dockerApi,
  execInContainer,
  sanitizeEnvVars,
  rewriteLocalhost,
  type DockerInspect,
} from "./api.ts";
import { resolveBaseImage, type DockerGitInfo } from "./utils.ts";

const PIDNAP_PORT = 9876;
const LIFECYCLE_TIMEOUT_MS = 120_000;
const TUNNEL_URL_TIMEOUT_MS = 120_000;
const TUNNEL_RATE_LIMIT_MARKER = "__CLOUDFLARE_TUNNEL_RATE_LIMIT__";

// Port definitions matching backend/daemons.ts
const DAEMON_PORTS = [
  { id: "iterate-daemon", internalPort: 3000 },
  { id: "iterate-daemon-server", internalPort: 3001 },
  { id: "opencode", internalPort: 4096 },
] as const;
type DockerServiceTransport = "port-map" | "cloudflare-tunnel";

/**
 * Zod schema for Docker provider environment variables.
 */
const DockerEnv = z.object({
  DOCKER_DEFAULT_IMAGE: z.string().optional(),
  DOCKER_COMPOSE_PROJECT_NAME: z.string().optional(),
  DOCKER_HOST_GIT_REPO_ROOT: z.string(),
  DOCKER_HOST_GIT_DIR: z.string().optional(),
  DOCKER_HOST_GIT_COMMON_DIR: z.string().optional(),
  DOCKER_HOST_GIT_COMMIT: z.string().optional(),
  DOCKER_HOST_GIT_BRANCH: z.string().optional(),
  DOCKER_DEFAULT_SERVICE_TRANSPORT: z.enum(["port-map", "cloudflare-tunnel"]).default("port-map"),
  DOCKER_TUNNEL_PORTS: z.string().optional(),
  DOCKER_HOST_SYNC_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true"),
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
  private readonly serviceTransport: DockerServiceTransport;

  constructor(
    containerId: string,
    ports: Record<number, number>,
    internalPorts: number[],
    serviceTransport: DockerServiceTransport,
  ) {
    super();
    this.providerId = containerId;
    this.ports = ports;
    this.internalPorts = internalPorts;
    this.serviceTransport = serviceTransport;
  }

  private async ensurePortsResolved(): Promise<void> {
    if (!this.providerId) {
      throw new Error("Cannot resolve ports: machine is still provisioning (no container ID yet)");
    }
    const hasAllPorts = this.internalPorts.every((internalPort) => this.ports[internalPort]);
    if (hasAllPorts) return;
    this.ports = await resolveHostPorts({
      containerId: this.providerId,
      internalPorts: this.internalPorts,
    });
  }

  private async getCloudflarePreviewUrl(port: number): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < TUNNEL_URL_TIMEOUT_MS) {
      try {
        const urlOrMarker = (
          await execInContainer({
            containerId: this.providerId,
            cmd: [
              "sh",
              "-c",
              `set -eu
              log_file="/var/log/pidnap/cloudflared-${port}.log"
              url="$(cat /tmp/cloudflare-tunnels/${port}.url 2>/dev/null || true)"
              if [ -z "$url" ]; then
                url="$(grep -Eo 'https://[[:alnum:]-]+\\.trycloudflare\\.com' "$log_file" 2>/dev/null | tail -n 1 || true)"
              fi
              if [ -z "$url" ] && [ -f "$log_file" ] && grep -Eq '429 Too Many Requests|error code: 1015' "$log_file"; then
                printf '%s' "${TUNNEL_RATE_LIMIT_MARKER}"
              else
                printf '%s' "$url"
              fi`,
            ],
          })
        ).trim();
        if (urlOrMarker === TUNNEL_RATE_LIMIT_MARKER) {
          const logTail = await execInContainer({
            containerId: this.providerId,
            cmd: [
              "sh",
              "-c",
              `tail -n 80 /var/log/pidnap/cloudflared-${port}.log 2>/dev/null || true`,
            ],
          }).catch(() => "");
          throw new Error(`Cloudflare quick tunnel rate-limited for port ${port}.\n${logTail}`);
        }

        if (urlOrMarker.startsWith("https://")) {
          return urlOrMarker;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("rate-limited")) {
          throw error;
        }
        // Container may still be starting.
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const logTail = await execInContainer({
      containerId: this.providerId,
      cmd: ["sh", "-c", `tail -n 80 /var/log/pidnap/cloudflared-${port}.log 2>/dev/null || true`],
    }).catch(() => "");
    throw new Error(
      `Timeout waiting for Cloudflare tunnel URL for port ${port}. cloudflared log:\n${logTail}`,
    );
  }

  async getBaseUrl(opts: { port: number }): Promise<string> {
    if (this.serviceTransport === "cloudflare-tunnel") {
      return this.getCloudflarePreviewUrl(opts.port);
    }
    await this.ensurePortsResolved();
    const hostPort = this.ports[opts.port];
    if (!hostPort) {
      throw new Error(`No host port mapped for ${opts.port}`);
    }
    return `http://127.0.0.1:${hostPort}`;
  }

  // === Lifecycle ===

  async exec(cmd: string[]): Promise<string> {
    return execInContainer({ containerId: this.providerId, cmd });
  }

  async getState(): Promise<ProviderState> {
    try {
      const inspect = await dockerApi<DockerInspect>({
        method: "GET",
        endpoint: `/containers/${this.providerId}/json`,
      });
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
    await withTimeout({
      promise: dockerApi({
        method: "POST",
        endpoint: `/containers/${this.providerId}/start`,
        body: {},
      }),
      timeoutMs: LIFECYCLE_TIMEOUT_MS,
      operation: "start",
    });
    this.ports = await resolveHostPorts({
      containerId: this.providerId,
      internalPorts: this.internalPorts,
    });
  }

  async stop(): Promise<void> {
    try {
      await dockerApi({
        method: "POST",
        endpoint: `/containers/${this.providerId}/stop`,
        body: {},
      });
    } catch {
      // Container might already be stopped
    }
  }

  async restart(): Promise<void> {
    await withTimeout({
      promise: dockerApi({
        method: "POST",
        endpoint: `/containers/${this.providerId}/restart`,
        body: {},
      }),
      timeoutMs: LIFECYCLE_TIMEOUT_MS,
      operation: "restart",
    });
    this.ports = await resolveHostPorts({
      containerId: this.providerId,
      internalPorts: this.internalPorts,
    });
  }

  async delete(): Promise<void> {
    try {
      await dockerApi({
        method: "DELETE",
        endpoint: `/containers/${this.providerId}?force=true`,
      });
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
    this.repoRoot = this.env.DOCKER_HOST_GIT_REPO_ROOT;
    if (this.env.DOCKER_HOST_SYNC_ENABLED) {
      // Git info must be resolved at build/boot time (alchemy.run.ts) and injected
      // as env vars — execSync is not available in the workerd/Vite SSR runtime.
      const { DOCKER_HOST_GIT_DIR, DOCKER_HOST_GIT_COMMON_DIR, DOCKER_HOST_GIT_COMMIT } = this.env;
      if (!DOCKER_HOST_GIT_DIR || !DOCKER_HOST_GIT_COMMON_DIR) {
        throw new Error(
          "DOCKER_HOST_SYNC_ENABLED=true requires DOCKER_HOST_GIT_DIR and DOCKER_HOST_GIT_COMMON_DIR env vars " +
            "(resolved by alchemy.run.ts at boot time)",
        );
      }
      this.gitInfo = {
        repoRoot: this.repoRoot,
        gitDir: DOCKER_HOST_GIT_DIR,
        commonDir: DOCKER_HOST_GIT_COMMON_DIR,
        commit: DOCKER_HOST_GIT_COMMIT ?? "unknown",
        branch: this.env.DOCKER_HOST_GIT_BRANCH,
      };
    } else {
      this.gitInfo = undefined;
    }
  }

  get defaultSnapshotId(): string {
    return resolveBaseImage({ imageName: this.env.DOCKER_DEFAULT_IMAGE });
  }

  async create(opts: CreateSandboxOptions): Promise<DockerSandbox> {
    const imageName = resolveBaseImage({
      imageName: opts.providerSnapshotId ?? this.defaultSnapshotId,
    });
    const entrypointArguments = opts.entrypointArguments;
    const hasEntrypointArguments = Boolean(entrypointArguments?.length);

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

    // Rewrite localhost references so the container can reach host services
    const rewrittenEnvVars = Object.fromEntries(
      Object.entries(opts.envVars).map(([key, value]) => [key, rewriteLocalhost(String(value))]),
    );

    const dockerEnv: Record<string, string> = {
      ...rewrittenEnvVars,
      ITERATE_DEV: "true",
      DOCKER_DEFAULT_SERVICE_TRANSPORT: this.env.DOCKER_DEFAULT_SERVICE_TRANSPORT,
      ...(this.env.DOCKER_TUNNEL_PORTS
        ? { DOCKER_TUNNEL_PORTS: this.env.DOCKER_TUNNEL_PORTS }
        : {}),
      ...(this.gitInfo ? { DOCKER_HOST_SYNC_ENABLED: "true" } : {}),
    };

    const envArray = sanitizeEnvVars(dockerEnv);

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

    const createResponse = await dockerApi<{ Id: string }>({
      method: "POST",
      endpoint: `/containers/create?name=${encodeURIComponent(containerName)}`,
      body: {
        Image: imageName,
        ...(hasEntrypointArguments ? { Cmd: entrypointArguments } : {}),
        Env: envArray,
        ExposedPorts: exposedPorts,
        HostConfig: hostConfig,
        Labels: labels,
      },
    });

    const containerId = createResponse.Id;
    await dockerApi({ method: "POST", endpoint: `/containers/${containerId}/start`, body: {} });

    const internalPorts = [...DAEMON_PORTS.map((daemon) => daemon.internalPort), PIDNAP_PORT];
    const ports = await resolveHostPorts({ containerId, internalPorts });
    const sandbox = new DockerSandbox(
      containerId,
      ports,
      internalPorts,
      this.env.DOCKER_DEFAULT_SERVICE_TRANSPORT,
    );
    const maxWaitMs = 30000;

    if (hasEntrypointArguments) {
      const start = Date.now();
      while (Date.now() - start < maxWaitMs) {
        try {
          await sandbox.exec(["true"]);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      await waitForEntrypointSignal({ sandbox, timeoutMs: maxWaitMs });

      if (this.gitInfo?.commit) {
        // Worktree sync is occasionally still settling immediately after the signal.
        // A short fixed delay has proven more stable than extra polling here.
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    if (!hasEntrypointArguments) {
      const pidnap = await getPidnapClientForSandbox(sandbox);
      const start = Date.now();
      while (Date.now() - start < maxWaitMs) {
        try {
          await pidnap.health();
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      await waitForEntrypointSignal({ sandbox, timeoutMs: maxWaitMs });

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

    return sandbox;
  }

  get(providerId: string): DockerSandbox | null {
    return this.getWithPorts({ providerId });
  }

  getWithPorts(params: {
    providerId: string;
    knownPorts?: Record<number, number>;
  }): DockerSandbox | null {
    const { providerId, knownPorts } = params;
    // For Docker, we can't easily check if container exists without API call
    // Return a handle and let operations fail if container doesn't exist
    const internalPorts = [...DAEMON_PORTS.map((d) => d.internalPort), PIDNAP_PORT];
    return new DockerSandbox(
      providerId,
      knownPorts ?? {},
      internalPorts,
      this.env.DOCKER_DEFAULT_SERVICE_TRANSPORT,
    );
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    const containers = await dockerApi<
      Array<{
        Id: string;
        Names: string[];
        State: string;
        Labels: Record<string, string>;
      }>
    >({
      method: "GET",
      endpoint: `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: ["com.iterate.sandbox=true"] }))}`,
    });

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
    >({ method: "GET", endpoint: `/images/json` });

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

async function resolveHostPorts(params: {
  containerId: string;
  internalPorts: number[];
}): Promise<Record<number, number>> {
  const { containerId, internalPorts } = params;
  const inspect = await dockerApi<DockerInspect>({
    method: "GET",
    endpoint: `/containers/${containerId}/json`,
  });
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

async function waitForEntrypointSignal(params: {
  sandbox: Sandbox;
  timeoutMs: number;
}): Promise<void> {
  const { sandbox, timeoutMs } = params;
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

async function withTimeout<T>(params: {
  promise: Promise<T>;
  timeoutMs: number;
  operation: string;
}): Promise<T> {
  const { promise, timeoutMs, operation } = params;
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
