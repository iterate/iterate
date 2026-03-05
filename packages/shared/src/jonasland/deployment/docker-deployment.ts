import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { DockerClient } from "@docker/node-sdk";
import pWaitFor from "p-wait-for";
import {
  Deployment,
  type DeploymentProvider,
  type DeploymentProviderStatus,
  type ProvisionResult,
  throwIfAborted,
  type DeploymentCommandResult,
  type DeploymentOpts,
} from "./deployment.ts";
import { collectTextOutput } from "./deployment-utils.ts";

type DockerSdkClient = Awaited<ReturnType<typeof DockerClient.fromDockerConfig>>;
type DockerCreateBody = Parameters<DockerSdkClient["containerCreate"]>[0];
type DockerHostConfig = NonNullable<DockerCreateBody["HostConfig"]>;

export interface DockerHostSyncConfig {
  repoRoot: string;
  gitDir?: string;
  commonDir?: string;
  repoCheckoutMountPath?: string;
  gitDirMountPath?: string;
  commonDirMountPath?: string;
}

export interface DockerDeploymentLocator {
  provider: "docker";
  containerId: string;
  name?: string;
}

export interface DockerDeploymentOpts extends Omit<DeploymentOpts, "env"> {
  env?: Record<string, string>;
  dockerImage?: string;
  dockerHostConfig?: DockerHostConfig;
  /**
   * Enable host-repo sync during sandbox boot.
   *
   * This sets `DOCKER_HOST_SYNC_ENABLED=true` inside the container and mounts
   * host checkout paths so `jonasland/sandbox/start.sh` can run
   * `providers/docker/sync-repo-from-host.sh` before pidnap starts.
   *
   * - `true`: derive host paths from `DOCKER_HOST_GIT_*` env vars on the caller.
   * - object: use explicit host paths/mounts.
   */
  dockerHostSync?: true | DockerHostSyncConfig;
}

let dockerClientPromise: Promise<DockerClient> | undefined;

async function dockerClient(): Promise<DockerClient> {
  if (!dockerClientPromise) {
    dockerClientPromise = DockerClient.fromDockerConfig();
  }
  try {
    return await dockerClientPromise;
  } catch (error) {
    dockerClientPromise = undefined;
    throw error;
  }
}

function normalizeDockerNameForHost(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return normalized.length > 0 ? normalized : "docker-deployment";
}

function resolveContainerName(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }
  return `docker-deployment-${randomUUID().slice(0, 8)}`;
}

class DockerProvider implements DeploymentProvider<DockerDeploymentOpts, DockerDeploymentLocator> {
  private async waitForPublishedPort(params: {
    containerId: string;
    containerPort: string;
    signal?: AbortSignal;
  }): Promise<number> {
    const docker = await dockerClient();
    let resolved: number | undefined;
    await pWaitFor(
      async () => {
        throwIfAborted(params.signal);
        const info = await docker.containerInspect(params.containerId);
        const hostPort = info.NetworkSettings?.Ports?.[params.containerPort]?.[0]?.HostPort;
        if (hostPort) {
          resolved = Number(hostPort);
          return true;
        }
        return false;
      },
      {
        interval: 100,
        timeout: {
          milliseconds: 10_000,
          message: `No published port for ${params.containerPort}`,
        },
        signal: params.signal,
      },
    );
    return resolved!;
  }

  async create(opts: DockerDeploymentOpts): Promise<ProvisionResult<DockerDeploymentLocator>> {
    if (!opts.dockerImage) throw new Error("dockerImage is required");
    const docker = await dockerClient();
    throwIfAborted(opts.signal);
    const hostSync = resolveDockerHostSync(opts);
    const hostSyncBinds =
      hostSync == null
        ? []
        : [
            `${hostSync.repoRoot}:${hostSync.repoCheckoutMountPath}:ro`,
            ...(hostSync.gitDir ? [`${hostSync.gitDir}:${hostSync.gitDirMountPath}:ro`] : []),
            ...(hostSync.commonDir
              ? [`${hostSync.commonDir}:${hostSync.commonDirMountPath}:ro`]
              : []),
          ];
    const defaultHostConfig: DockerHostConfig = {
      PortBindings: { "80/tcp": [{ HostPort: "" }] },
      ExtraHosts: ["host.docker.internal:host-gateway"],
      CapAdd: ["NET_ADMIN"],
      ...(hostSyncBinds.length > 0 ? { Binds: hostSyncBinds } : {}),
    };
    const hostConfig: DockerHostConfig = {
      ...defaultHostConfig,
      ...opts.dockerHostConfig,
      ExtraHosts: dedupeStringList([
        ...(defaultHostConfig.ExtraHosts ?? []),
        ...(opts.dockerHostConfig?.ExtraHosts ?? []),
      ]),
      CapAdd: dedupeStringList([
        ...(defaultHostConfig.CapAdd ?? []),
        ...(opts.dockerHostConfig?.CapAdd ?? []),
      ]),
      Binds: dedupeStringList([
        ...(defaultHostConfig.Binds ?? []),
        ...(opts.dockerHostConfig?.Binds ?? []),
      ]),
      PortBindings: {
        ...(defaultHostConfig.PortBindings ?? {}),
        ...(opts.dockerHostConfig?.PortBindings ?? {}),
      },
    };
    const containerName = resolveContainerName(opts.name);
    const publicBaseHost = `${normalizeDockerNameForHost(containerName)}.orb.local`;
    const env = {
      ITERATE_PUBLIC_BASE_HOST: publicBaseHost,
      ITERATE_PUBLIC_BASE_HOST_TYPE: "subdomain",
      ...(opts.env ?? {}),
      ...(hostSync ? { DOCKER_HOST_SYNC_ENABLED: "true" } : {}),
    };

    console.log(`[docker] creating container image=${opts.dockerImage}...`);
    const created = await docker.containerCreate(
      {
        Image: opts.dockerImage,
        Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
        ExposedPorts: { "80/tcp": {} },
        HostConfig: hostConfig,
      },
      { name: containerName },
    );
    const containerId =
      (created as { Id?: string }).Id ??
      (created as { id?: string }).id ??
      (created as { body?: { Id?: string; id?: string } }).body?.Id ??
      (created as { body?: { Id?: string; id?: string } }).body?.id;
    if (!containerId) {
      throw new Error(`docker container create id missing: ${JSON.stringify(created)}`);
    }
    throwIfAborted(opts.signal);
    await docker.containerStart(containerId);

    const hostPort = await this.waitForPublishedPort({
      containerId,
      containerPort: "80/tcp",
      signal: opts.signal,
    });
    const baseUrl = `http://127.0.0.1:${String(hostPort)}`;
    console.log(`[docker] container=${containerId.slice(0, 12)} port=${String(hostPort)}`);

    return {
      baseUrl,
      locator: {
        provider: "docker",
        containerId,
        name: containerName,
      },
    };
  }

  async destroy(params: { locator: DockerDeploymentLocator }): Promise<void> {
    const docker = await dockerClient();
    const containerId = params.locator.containerId;
    console.log(`[docker] disposing container=${containerId.slice(0, 12)}`);
    await docker.containerStop(containerId, { timeout: 3 }).catch(() => {});
    await docker.containerDelete(containerId, { force: true }).catch(() => {});
  }

  async exec(params: {
    locator: DockerDeploymentLocator;
    cmd: string | string[];
  }): Promise<DeploymentCommandResult> {
    const docker = await dockerClient();
    const argv = typeof params.cmd === "string" ? ["sh", "-ec", params.cmd] : params.cmd;
    const exec = await docker.containerExec(params.locator.containerId, {
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: argv,
    });
    if (!exec.Id) throw new Error("docker exec id missing");

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutCapture = collectTextOutput(stdout);
    const stderrCapture = collectTextOutput(stderr);
    await docker.execStart(exec.Id, stdout, stderr, { Detach: false, Tty: false });
    const inspect = await docker.execInspect(exec.Id);

    return {
      exitCode: inspect.ExitCode ?? 0,
      output: `${stdoutCapture.flush()}${stderrCapture.flush()}`,
    };
  }

  async logs(params: { locator: DockerDeploymentLocator }): Promise<string> {
    const docker = await dockerClient();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutCap = collectTextOutput(stdout);
    const stderrCap = collectTextOutput(stderr);
    await docker.containerLogs(params.locator.containerId, stdout, stderr, {
      stdout: true,
      stderr: true,
      tail: "all",
    });
    return `${stdoutCap.flush()}${stderrCap.flush()}`;
  }

  async status(params: { locator: DockerDeploymentLocator }): Promise<DeploymentProviderStatus> {
    const docker = await dockerClient();
    const info = await docker.containerInspect(params.locator.containerId);
    const raw = info.State?.Status ?? "unknown";
    const state =
      raw === "running"
        ? "running"
        : raw === "created" || raw === "restarting"
          ? "starting"
          : raw === "exited"
            ? "stopped"
            : raw === "dead" || raw === "removing"
              ? "destroyed"
              : "unknown";
    const detail = [
      `docker state=${raw}`,
      info.State?.Health?.Status ? `health=${info.State.Health.Status}` : null,
      typeof info.State?.ExitCode === "number" ? `exitCode=${String(info.State.ExitCode)}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    return { state, detail: detail || "docker status unavailable" };
  }
}

export class DockerDeployment extends Deployment<DockerDeploymentOpts, DockerDeploymentLocator> {
  constructor() {
    super(new DockerProvider());
  }

  async containerInspect(): Promise<Awaited<ReturnType<DockerSdkClient["containerInspect"]>>> {
    const docker = await dockerClient();
    return await docker.containerInspect(this.locator.containerId);
  }

  static async create(opts: DockerDeploymentOpts): Promise<DockerDeployment> {
    const deployment = new DockerDeployment();
    await deployment.create(opts);
    return deployment;
  }
}

function dedupeStringList(values: Array<string | undefined>): string[] | undefined {
  const unique = [...new Set(values.filter((value): value is string => Boolean(value)))];
  return unique.length > 0 ? unique : undefined;
}

function resolveDockerHostSync(opts: DockerDeploymentOpts): DockerHostSyncConfig | null {
  if (opts.dockerHostSync && opts.dockerHostSync !== true) {
    return {
      repoCheckoutMountPath: "/host/repo-checkout",
      gitDirMountPath: "/host/gitdir",
      commonDirMountPath: "/host/commondir",
      ...opts.dockerHostSync,
    };
  }

  if (opts.dockerHostSync !== true && process.env.DOCKER_HOST_SYNC_ENABLED !== "true") {
    return null;
  }

  const repoRoot = process.env.DOCKER_HOST_GIT_REPO_ROOT;
  if (!repoRoot) {
    throw new Error("DOCKER_HOST_SYNC_ENABLED=true requires DOCKER_HOST_GIT_REPO_ROOT");
  }

  return {
    repoRoot,
    gitDir: process.env.DOCKER_HOST_GIT_DIR,
    commonDir: process.env.DOCKER_HOST_GIT_COMMON_DIR,
    repoCheckoutMountPath: "/host/repo-checkout",
    gitDirMountPath: "/host/gitdir",
    commonDirMountPath: "/host/commondir",
  };
}
