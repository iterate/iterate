import { PassThrough } from "node:stream";
import { DockerClient } from "@docker/node-sdk";
import pWaitFor from "p-wait-for";
import {
  Deployment,
  throwIfAborted,
  type DeploymentCommandResult,
  type DeploymentOpts,
} from "./deployment.ts";
import { collectTextOutput } from "./deployment-utils.ts";

type DockerSdkClient = Awaited<ReturnType<typeof DockerClient.fromDockerConfig>>;
type DockerCreateBody = Parameters<DockerSdkClient["containerCreate"]>[0];
type DockerHostConfig = NonNullable<DockerCreateBody["HostConfig"]>;

export interface DockerDeploymentLocator {
  provider: "docker";
  containerId: string;
  name?: string;
}

export interface DockerDeploymentOpts extends Omit<DeploymentOpts, "env"> {
  env?: Record<string, string>;
  dockerImage?: string;
  dockerHostConfig?: DockerHostConfig;
  dockerHostSync?: {
    repoRoot: string;
    gitDir?: string;
    commonDir?: string;
    repoCheckoutMountPath?: string;
    gitDirMountPath?: string;
    commonDirMountPath?: string;
  };
}

export class DockerDeployment extends Deployment<DockerDeploymentOpts, DockerDeploymentLocator> {
  private static dockerClientPromise: Promise<DockerClient> | undefined;
  private containerId: string | null = null;

  private static async dockerClient(): Promise<DockerClient> {
    if (!DockerDeployment.dockerClientPromise) {
      DockerDeployment.dockerClientPromise = DockerClient.fromDockerConfig();
    }
    try {
      return await DockerDeployment.dockerClientPromise;
    } catch (error) {
      DockerDeployment.dockerClientPromise = undefined;
      throw error;
    }
  }

  private requireContainerId(): string {
    if (!this.containerId) throw new Error("docker deployment not initialized");
    return this.containerId;
  }

  private async waitForPublishedPort(containerPort: string, signal?: AbortSignal): Promise<number> {
    const docker = await DockerDeployment.dockerClient();
    const containerId = this.requireContainerId();
    let resolved: number | undefined;
    await pWaitFor(
      async () => {
        throwIfAborted(signal);
        const info = await docker.containerInspect(containerId);
        const hostPort = info.NetworkSettings?.Ports?.[containerPort]?.[0]?.HostPort;
        if (hostPort) {
          resolved = Number(hostPort);
          return true;
        }
        return false;
      },
      {
        interval: 100,
        timeout: { milliseconds: 10_000, message: `No published port for ${containerPort}` },
        signal,
      },
    );
    return resolved!;
  }

  override async create(opts: DockerDeploymentOpts): Promise<DockerDeploymentLocator> {
    if (this.state !== "new") {
      throw new Error(`${this.constructor.name} is in state "${this.state}", expected "new"`);
    }
    console.log(`[deployment] creating ${this.constructor.name}...`);
    throwIfAborted(opts.signal);
    if (!opts.dockerImage) throw new Error("dockerImage is required");
    const docker = await DockerDeployment.dockerClient();
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
    const env = { ...(opts.env ?? {}), ...(hostSync ? { DOCKER_HOST_SYNC_ENABLED: "true" } : {}) };

    console.log(`[docker] creating container image=${opts.dockerImage}...`);
    const created = await docker.containerCreate(
      {
        Image: opts.dockerImage,
        Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
        ExposedPorts: { "80/tcp": {} },
        HostConfig: hostConfig,
      },
      { name: opts.name },
    );
    const containerId =
      (created as { Id?: string }).Id ??
      (created as { id?: string }).id ??
      (created as { body?: { Id?: string; id?: string } }).body?.Id ??
      (created as { body?: { Id?: string; id?: string } }).body?.id;
    if (!containerId) {
      throw new Error(`docker container create id missing: ${JSON.stringify(created)}`);
    }
    this.containerId = containerId;
    throwIfAborted(opts.signal);
    await docker.containerStart(this.containerId);

    const hostPort = await this.waitForPublishedPort("80/tcp", opts.signal);
    const baseUrl = `http://127.0.0.1:${String(hostPort)}`;
    console.log(`[docker] container=${this.containerId.slice(0, 12)} port=${String(hostPort)}`);

    const locator = {
      provider: "docker" as const,
      containerId: this.containerId,
      name: opts.name,
    };
    this.baseUrl = baseUrl;
    this.locator = locator;
    this.state = "running";
    console.log(`[deployment] created, baseUrl=${this.baseUrl}`);
    return locator;
  }

  override async exec(cmd: string | string[]): Promise<DeploymentCommandResult> {
    this.assertRunning();
    const docker = await DockerDeployment.dockerClient();
    const containerId = this.requireContainerId();
    const argv = typeof cmd === "string" ? ["sh", "-ec", cmd] : cmd;
    const exec = await docker.containerExec(containerId, {
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

  override async logs(): Promise<string> {
    this.assertRunning();
    const docker = await DockerDeployment.dockerClient();
    const containerId = this.requireContainerId();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutCap = collectTextOutput(stdout);
    const stderrCap = collectTextOutput(stderr);
    await docker.containerLogs(containerId, stdout, stderr, {
      stdout: true,
      stderr: true,
      tail: "all",
    });
    return `${stdoutCap.flush()}${stderrCap.flush()}`;
  }

  protected override async dispose(): Promise<void> {
    if (!this.containerId) return;
    const docker = await DockerDeployment.dockerClient();
    const containerId = this.containerId;
    console.log(`[docker] disposing container=${containerId.slice(0, 12)}`);
    await docker.containerStop(containerId, { timeout: 3 }).catch(() => {});
    await docker.containerDelete(containerId, { force: true }).catch(() => {});
    this.containerId = null;
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

function resolveDockerHostSync(
  opts: DockerDeploymentOpts,
): NonNullable<DockerDeploymentOpts["dockerHostSync"]> | null {
  if (opts.dockerHostSync) {
    return {
      repoCheckoutMountPath: "/host/repo-checkout",
      gitDirMountPath: "/host/gitdir",
      commonDirMountPath: "/host/commondir",
      ...opts.dockerHostSync,
    };
  }

  if (process.env.DOCKER_HOST_SYNC_ENABLED !== "true") {
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
