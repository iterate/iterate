/**
 * Local Docker Provider
 *
 * Provider for local Docker development using direct Docker API calls.
 * Each docker machine gets its own container with fixed host ports.
 *
 * Optional: DOCKER_COMPOSE_PROJECT_NAME is used for UI grouping labels.
 */

import {
  dockerApi,
  rewriteLocalhost,
  sanitizeEnvVars,
  type DockerInspect,
} from "@iterate-com/sandbox/providers/docker/api";
import { DAEMON_DEFINITIONS } from "../daemons.ts";
import { slugify } from "../utils/slug.ts";
import type { MachineProvider, CreateMachineConfig, MachineProviderResult } from "./types.ts";

const DEFAULT_DAEMON_PORT = 3000;
const PIDNAP_PORT = 9876;

// ============================================================================
// Local Docker Utilities
// ============================================================================

type LocalDockerMounts = {
  repoCheckout: string;
  gitDir: string;
  commonDir: string;
};

function resolveDockerMounts(opts?: {
  repoCheckout?: string;
  gitDir?: string;
  commonDir?: string;
}): LocalDockerMounts | null {
  // Flow:
  // 1) alchemy.run.ts runs in node, can exec git to derive repo paths.
  // 2) those paths are injected into the worker env (workerd/miniflare).
  // 3) this provider reads the env vars and mounts host git paths via Docker API.
  const repoCheckout = opts?.repoCheckout ?? process.env.DOCKER_GIT_REPO_ROOT;
  const gitDir = opts?.gitDir ?? process.env.DOCKER_GIT_GITDIR;
  const commonDir = opts?.commonDir ?? process.env.DOCKER_GIT_COMMON_DIR;
  if (!repoCheckout || !gitDir || !commonDir) return null;

  return {
    repoCheckout,
    gitDir,
    commonDir,
  };
}

async function resolveHostPorts(containerId: string): Promise<Record<string, number>> {
  const inspect = await dockerApi<DockerInspect>("GET", `/containers/${containerId}/json`);
  const ports = inspect.NetworkSettings?.Ports ?? {};
  const resolved: Record<string, number> = {};

  for (const daemon of DAEMON_DEFINITIONS) {
    const key = `${daemon.internalPort}/tcp`;
    const bindings = ports[key];
    const hostPortRaw = Array.isArray(bindings) ? bindings[0]?.HostPort : undefined;
    if (!hostPortRaw) {
      throw new Error(`No host port mapped for ${key}`);
    }
    const hostPort = Number(hostPortRaw);
    if (Number.isNaN(hostPort)) {
      throw new Error(`Invalid host port for ${key}: ${hostPortRaw}`);
    }
    resolved[daemon.id] = hostPort;
  }

  const pidnapKey = `${PIDNAP_PORT}/tcp`;
  const pidnapBindings = ports[pidnapKey];
  const pidnapHostPortRaw = Array.isArray(pidnapBindings) ? pidnapBindings[0]?.HostPort : undefined;
  if (!pidnapHostPortRaw) {
    throw new Error(`No host port mapped for ${pidnapKey}`);
  }
  const pidnapHostPort = Number(pidnapHostPortRaw);
  if (Number.isNaN(pidnapHostPort)) {
    throw new Error(`Invalid host port for ${pidnapKey}: ${pidnapHostPortRaw}`);
  }
  resolved["pidnap"] = pidnapHostPort;

  return resolved;
}

// NOTE: Workerd runtime: do not use child_process/execSync here (no exec allowed).
// Any host-side setup (like git lookups or creating docker volumes) must happen in alchemy.run.ts.

// ============================================================================
// Local Provider - reference to an already-running daemon on the host
// ============================================================================

export interface LocalProviderConfig {
  host: string;
  ports: Record<string, number>;
  buildProxyUrl: (port: number) => string;
}

export function createLocalProvider(config: LocalProviderConfig): MachineProvider {
  const { host, ports } = config;

  const getUrl = (port: number): string => {
    const daemon = DAEMON_DEFINITIONS.find((definition) => definition.internalPort === port);
    if (daemon && ports[daemon.id]) {
      return `http://${host}:${ports[daemon.id]}`;
    }
    if (ports["iterate-daemon"]) {
      return `http://${host}:${ports["iterate-daemon"]}`;
    }
    return `http://${host}:${port}`;
  };

  const displayPort = ports["iterate-daemon"] ?? DEFAULT_DAEMON_PORT;

  return {
    type: "local",

    async create(machineConfig: CreateMachineConfig): Promise<MachineProviderResult> {
      return {
        externalId: machineConfig.machineId,
        metadata: {
          host,
          ports,
          daemonStatus: "ready",
          daemonReadyAt: new Date().toISOString(),
        },
      };
    },

    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async restart(): Promise<void> {},
    async archive(): Promise<void> {},
    async delete(): Promise<void> {},

    getPreviewUrl: getUrl,
    previewUrl: getUrl(DEFAULT_DAEMON_PORT),

    displayInfo: {
      label: `Local ${host}:${displayPort}`,
    },
  };
}

// ============================================================================
// Local Docker Provider
// Creates Docker containers directly via Docker API
// ============================================================================

export interface LocalDockerProviderConfig {
  imageName: string;
  externalId: string;
  metadata: {
    containerId?: string;
    port?: number;
    ports?: Record<string, number>;
    localDocker?: {
      imageName?: string;
      syncRepo?: boolean;
    };
  };
  composeProjectName?: string;
  repoCheckout?: string;
  gitDir?: string;
  commonDir?: string;
}

export function createLocalDockerProvider(config: LocalDockerProviderConfig): MachineProvider {
  const { imageName, externalId, metadata, composeProjectName, repoCheckout, gitDir, commonDir } =
    config;
  const localDockerMeta = (metadata.localDocker ?? {}) as {
    imageName?: string;
    syncRepo?: boolean;
  };
  const resolvedImageName = localDockerMeta.imageName ?? imageName;
  const syncRepo = localDockerMeta.syncRepo ?? true;

  const getUrl = (port: number): string => {
    if (metadata.ports) {
      const daemon = DAEMON_DEFINITIONS.find((d) => d.internalPort === port);
      if (daemon && metadata.ports[daemon.id]) {
        return `http://localhost:${metadata.ports[daemon.id]}`;
      }
      if (metadata.ports["iterate-daemon"]) {
        return `http://localhost:${metadata.ports["iterate-daemon"]}`;
      }
    }
    // Legacy fallback
    const baseHostPort = metadata.port ?? DEFAULT_DAEMON_PORT;
    return `http://localhost:${baseHostPort}`;
  };

  const displayPort = metadata.ports?.["iterate-daemon"] ?? metadata.port;

  return {
    type: "docker",

    async create(machineConfig: CreateMachineConfig): Promise<MachineProviderResult> {
      const portBindings: Record<string, Array<{ HostPort: string }>> = {};
      const exposedPorts: Record<string, object> = {};

      DAEMON_DEFINITIONS.forEach((daemon) => {
        const internalPortKey = `${daemon.internalPort}/tcp`;
        portBindings[internalPortKey] = [{ HostPort: "0" }];
        exposedPorts[internalPortKey] = {};
      });

      portBindings[`${PIDNAP_PORT}/tcp`] = [{ HostPort: "0" }];
      exposedPorts[`${PIDNAP_PORT}/tcp`] = {};

      const projectSlugRaw = machineConfig.envVars["ITERATE_PROJECT_SLUG"] ?? "project";
      const projectSlug = slugify(projectSlugRaw).slice(0, 30);
      const machineSlug = slugify(machineConfig.name).slice(0, 30);
      const containerName = `${projectSlug}--${machineSlug || machineConfig.machineId}`.slice(
        0,
        63,
      );

      const binds: string[] = [];
      const mounts = syncRepo ? resolveDockerMounts({ repoCheckout, gitDir, commonDir }) : null;
      if (mounts) {
        binds.push(`${mounts.repoCheckout}:/host/repo-checkout:ro`);
        binds.push(`${mounts.gitDir}:/host/gitdir:ro`);
        binds.push(`${mounts.commonDir}:/host/commondir:ro`);
      }
      // binds.push("iterate-pnpm-store:/home/iterate/.pnpm-store");

      const labels: Record<string, string> = {
        "com.iterate.machine_id": machineConfig.machineId,
      };
      if (composeProjectName) {
        labels["com.docker.compose.project"] = composeProjectName;
        labels["com.docker.compose.service"] = `sandbox--${containerName}`;
        labels["com.docker.compose.oneoff"] = "False";
      }

      const hostConfig: Record<string, unknown> = {
        PortBindings: portBindings,
        Binds: binds,
        ExtraHosts: ["host.docker.internal:host-gateway"],
      };

      const rewrittenEnvVars = Object.fromEntries(
        Object.entries(machineConfig.envVars).map(([key, value]) => [
          key,
          rewriteLocalhost(String(value)),
        ]),
      );

      const envVarsWithDev = {
        ...rewrittenEnvVars,
        ITERATE_DEV: "true",
        ...(mounts ? { DOCKER_SYNC_FROM_HOST_REPO: "true" } : {}),
      };

      const envArray = sanitizeEnvVars(envVarsWithDev);

      const createResponse = await dockerApi<{ Id: string }>(
        "POST",
        `/containers/create?name=${encodeURIComponent(containerName || machineConfig.machineId)}`,
        {
          Image: resolvedImageName,
          Env: envArray,
          ExposedPorts: exposedPorts,
          HostConfig: hostConfig,
          Labels: labels,
        },
      );

      const newContainerId = createResponse.Id;

      await dockerApi("POST", `/containers/${newContainerId}/start`, {});

      const ports = await resolveHostPorts(newContainerId);

      return {
        externalId: newContainerId,
        metadata: { ports, containerId: newContainerId, containerName },
      };
    },

    async start(): Promise<void> {
      await dockerApi("POST", `/containers/${externalId}/start`, {});
    },

    async stop(): Promise<void> {
      try {
        await dockerApi("POST", `/containers/${externalId}/stop`, {});
      } catch {
        // Container might already be stopped
      }
    },

    async restart(): Promise<void> {
      await dockerApi("POST", `/containers/${externalId}/restart`, {});
    },

    async archive(): Promise<void> {
      await this.stop();
    },

    async delete(): Promise<void> {
      await dockerApi("DELETE", `/containers/${externalId}?force=true`, undefined);
    },

    getPreviewUrl: getUrl,
    previewUrl: getUrl(DEFAULT_DAEMON_PORT),

    displayInfo: {
      label: `Local Docker :${displayPort ?? "?"}`,
    },
  };
}
