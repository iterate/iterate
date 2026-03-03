import { PassThrough } from "node:stream";
import { DockerClient } from "@docker/node-sdk";
import pWaitFor from "p-wait-for";
import { Deployment, type DeploymentCommandResult, type DeploymentOpts } from "./deployment.ts";

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

function toEnvArray(env?: Record<string, string> | string[]): string[] | undefined {
  if (!env) return undefined;
  if (Array.isArray(env)) return env;
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

function captureOutput(stream: PassThrough): { flush: () => string } {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  return {
    flush() {
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
}

export async function execInContainer(params: {
  containerId: string;
  cmd: string[];
}): Promise<DeploymentCommandResult> {
  const docker = await dockerClient();
  const exec = await docker.containerExec(params.containerId, {
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Cmd: params.cmd,
  });
  if (!exec.Id) throw new Error("docker exec id missing");

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutCapture = captureOutput(stdout);
  const stderrCapture = captureOutput(stderr);
  await docker.execStart(exec.Id, stdout, stderr, { Detach: false, Tty: false });
  const inspect = await docker.execInspect(exec.Id);

  return {
    exitCode: inspect.ExitCode ?? 0,
    output: `${stdoutCapture.flush()}${stderrCapture.flush()}`,
  };
}

type ContainerHandle = {
  containerId: string;
  publishedPort(containerPort: string): Promise<number>;
  logs(): Promise<string>;
  dispose(): Promise<void>;
};

async function createContainer(params: {
  image: string;
  name?: string;
  env?: Record<string, string> | string[];
  ingressHostPort?: number;
}): Promise<ContainerHandle> {
  const docker = await dockerClient();
  const portBindings: Record<string, Array<{ HostPort: string }>> = {
    "80/tcp": [{ HostPort: params.ingressHostPort ? String(params.ingressHostPort) : "" }],
  };

  const created = await docker.containerCreate(
    {
      Image: params.image,
      Env: toEnvArray(params.env),
      ExposedPorts: { "80/tcp": {} },
      HostConfig: {
        PortBindings: portBindings,
        ExtraHosts: ["host.docker.internal:host-gateway"],
        CapAdd: ["NET_ADMIN"],
      },
    },
    { name: params.name },
  );

  const createdId =
    (created as { Id?: string }).Id ??
    (created as { id?: string }).id ??
    (created as { body?: { Id?: string; id?: string } }).body?.Id ??
    (created as { body?: { Id?: string; id?: string } }).body?.id;
  if (!createdId) {
    throw new Error(`docker container create id missing: ${JSON.stringify(created)}`);
  }
  await docker.containerStart(createdId);

  return {
    containerId: createdId,
    async publishedPort(containerPort: string) {
      let resolved: number | undefined;
      await pWaitFor(
        async () => {
          const info = await docker.containerInspect(createdId);
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
        },
      );
      return resolved!;
    },
    async logs() {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdoutCap = captureOutput(stdout);
      const stderrCap = captureOutput(stderr);
      await docker.containerLogs(createdId, stdout, stderr, {
        stdout: true,
        stderr: true,
        tail: "all",
      });
      return `${stdoutCap.flush()}${stderrCap.flush()}`;
    },
    async dispose() {
      await docker.containerStop(createdId, { timeout: 3 }).catch(() => {});
      await docker.containerDelete(createdId, { force: true }).catch(() => {});
    },
  };
}

export interface DockerDeploymentLocator {
  provider: "docker";
  containerId: string;
  name?: string;
}

export interface DockerDeploymentOpts extends DeploymentOpts {
  dockerImage?: string;
  ingressHostPort?: number;
}

export class DockerDeployment extends Deployment<DockerDeploymentOpts, DockerDeploymentLocator> {
  private container: ContainerHandle | null = null;

  protected override async providerCreate(opts: DockerDeploymentOpts) {
    if (!opts.dockerImage) throw new Error("dockerImage is required");

    console.log(`[docker] creating container image=${opts.dockerImage}...`);
    this.container = await createContainer({
      image: opts.dockerImage,
      name: opts.name,
      env: opts.env,
      ingressHostPort: opts.ingressHostPort,
    });

    const hostPort = await this.container.publishedPort("80/tcp");
    const baseUrl = `http://iterate.localhost:${String(hostPort)}`;
    console.log(
      `[docker] container=${this.container.containerId.slice(0, 12)} port=${String(hostPort)}`,
    );

    return {
      locator: {
        provider: "docker" as const,
        containerId: this.container.containerId,
        name: opts.name,
      },
      baseUrl,
    };
  }

  protected override async providerDispose(): Promise<void> {
    if (!this.container) return;
    console.log(`[docker] disposing container=${this.container.containerId.slice(0, 12)}`);
    await this.container.dispose();
    this.container = null;
  }

  protected override async providerExec(cmd: string | string[]): Promise<DeploymentCommandResult> {
    if (!this.container) throw new Error("docker deployment not initialized");
    const argv = typeof cmd === "string" ? ["sh", "-ec", cmd] : cmd;
    return await execInContainer({ containerId: this.container.containerId, cmd: argv });
  }

  protected override async providerLogs(): Promise<string> {
    if (!this.container) throw new Error("docker deployment not initialized");
    return await this.container.logs();
  }

  static async create(opts: DockerDeploymentOpts): Promise<DockerDeployment> {
    const deployment = new DockerDeployment();
    await deployment.create(opts);
    return deployment;
  }
}
