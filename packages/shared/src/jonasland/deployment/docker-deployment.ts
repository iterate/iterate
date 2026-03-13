import { execSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { DockerClient } from "@docker/node-sdk";
import pWaitFor from "p-wait-for";
import { stripAnsi } from "../strip-ansi.ts";
import {
  type DeploymentProviderState,
  type DeploymentProvider,
} from "./deployment-provider-manifest.ts";
import { collectTextOutput, throwIfAborted } from "./deployment-utils.ts";
import {
  dockerProviderManifest,
  type DockerDeploymentRuntimeEnv,
  type DockerDeploymentLocator,
  type DockerDeploymentOpts,
  type DockerHostConfig,
  type DockerProviderOpts,
} from "./docker-deployment-manifest.ts";
export {
  dockerDeploymentLocatorSchema,
  dockerDeploymentOptsSchema,
  dockerProviderManifest,
  dockerProviderOptsSchema,
} from "./docker-deployment-manifest.ts";
export type {
  DockerDeploymentRuntimeEnv,
  DockerDeploymentLocator,
  DockerDeploymentOpts,
  DockerHostConfig,
  DockerProviderOpts,
} from "./docker-deployment-manifest.ts";

type DockerSdkClient = Awaited<ReturnType<typeof DockerClient.fromDockerConfig>>;
type DockerMount = NonNullable<NonNullable<DockerHostConfig["Mounts"]>[number]>;

// We persist effective deployment opts on the container so reconnect can
// recover provider-owned runtime shape from Docker alone, without an external
// opts store. `deployment.ts` later rehydrates live runtime env from
// `~/.iterate/.env`, so this metadata is best thought of as the config-side
// snapshot rather than the long-term env source of truth.
const DOCKER_RUNTIME_METADATA_LABEL = "com.iterate.instance-specific-opts";
const DOCKER_PNPM_STORE_VOLUME_NAME = "iterate-pnpm-store";
const DOCKER_PNPM_STORE_MOUNT_PATH = "/home/iterate/.pnpm-store";
const DOCKER_HOST_REPO_CHECKOUT_MOUNT_PATH = "/host/repo-checkout";
const DOCKER_HOST_GIT_DIR_MOUNT_PATH = "/host/gitdir";
const DOCKER_HOST_GIT_COMMON_DIR_MOUNT_PATH = "/host/commondir";

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

async function waitForPublishedPort(params: {
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

export function createDockerProvider(
  providerOpts: DockerProviderOpts = {},
): DeploymentProvider<DockerDeploymentOpts, DockerDeploymentLocator, DockerProviderOpts> {
  void providerOpts;

  return {
    ...dockerProviderManifest,
    async create(params) {
      const opts = withDefaultDockerOpts(params.opts);
      if (!opts.image) throw new Error("image is required");
      const docker = await dockerClient();
      throwIfAborted(params.signal);

      const hostSyncEnabled = opts.env?.DOCKER_HOST_SYNC_ENABLED === "true";
      const defaultMounts = mergeDockerMounts([
        createDockerPnpmStoreMount(),
        ...(hostSyncEnabled ? createDockerHostSyncMounts() : []),
      ]);

      const defaultHostConfig: DockerHostConfig = {
        PortBindings: { "80/tcp": [{ HostPort: "" }] },
        ExtraHosts: ["host.docker.internal:host-gateway"],
        CapAdd: ["NET_ADMIN"],
        ...(defaultMounts ? { Mounts: defaultMounts } : {}),
      };
      // Caller overrides merge into the default host config so provider
      // requirements stay in place unless explicitly replaced.
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
        Mounts: mergeDockerMounts([
          ...(defaultHostConfig.Mounts ?? []),
          ...(opts.dockerHostConfig?.Mounts ?? []),
        ]),
        PortBindings: {
          ...(defaultHostConfig.PortBindings ?? {}),
          ...(opts.dockerHostConfig?.PortBindings ?? {}),
        },
        Tmpfs: {
          ...(defaultHostConfig.Tmpfs ?? {}),
          ...(opts.dockerHostConfig?.Tmpfs ?? {}),
        },
      };

      const containerName = resolveContainerName(opts.slug);
      const publicBaseHost = `${normalizeDockerNameForHost(containerName)}.orb.local`;
      const effectiveOpts = withDefaultDockerOpts({
        ...opts,
        env: {
          ...(opts.env ?? {}),
          ITERATE_INGRESS_HOST: opts.env?.ITERATE_INGRESS_HOST ?? publicBaseHost,
          ITERATE_INGRESS_ROUTING_TYPE: opts.env?.ITERATE_INGRESS_ROUTING_TYPE ?? "subdomain-host",
        },
      });
      // Docker needs the full launch env up front, but `deployment.ts` treats
      // the runtime env file as canonical once the deployment is attached.
      const runtimeEnv = {
        ...(effectiveOpts.env ?? {}),
        ...(hostSyncEnabled ? { DOCKER_HOST_SYNC_ENABLED: "true" } : {}),
      };

      console.log(`[docker] creating container image=${opts.image}...`);
      const created = await docker.containerCreate(
        {
          Image: opts.image,
          ...(opts.entrypoint ? { Entrypoint: opts.entrypoint } : {}),
          ...(opts.cmd ? { Cmd: opts.cmd } : {}),
          Env: Object.entries(runtimeEnv).map(([key, value]) => `${key}=${value}`),
          ExposedPorts: { "80/tcp": {} },
          Labels: {
            "dev.orbstack.http-port": "80",
            [DOCKER_RUNTIME_METADATA_LABEL]: serializeDockerRuntimeMetadata(effectiveOpts),
          },
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

      throwIfAborted(params.signal);
      await docker.containerStart(containerId);

      const hostPort = await waitForPublishedPort({
        containerId,
        containerPort: "80/tcp",
        signal: params.signal,
      });
      const baseUrl = `http://127.0.0.1:${String(hostPort)}`;
      console.log(`[docker] container=${containerId.slice(0, 12)} port=${String(hostPort)}`);

      return {
        baseUrl,
        locator: {
          provider: "docker",
          containerId,
          containerName,
        },
      };
    },
    async connect(params) {
      const docker = await dockerClient();
      throwIfAborted(params.signal);
      const locator = toDockerLocator(params.locator);
      const info = await docker.containerInspect(locator.containerId);
      const hostPort = await waitForPublishedPort({
        containerId: locator.containerId,
        containerPort: "80/tcp",
        signal: params.signal,
      });
      return {
        baseUrl: `http://127.0.0.1:${String(hostPort)}`,
        locator: {
          ...locator,
          containerName: normalizeInspectName(info.Name) ?? locator.containerName,
        },
      };
    },
    async recoverOpts(params) {
      const docker = await dockerClient();
      const locator = toDockerLocator(params.locator);
      const info = await docker.containerInspect(locator.containerId);
      const metadata = parseDockerRuntimeMetadata(
        info.Config?.Labels?.[DOCKER_RUNTIME_METADATA_LABEL],
      );
      return {
        ...metadata,
        ...(info.Config?.Image ? { image: info.Config.Image } : {}),
        ...(info.Config?.Cmd ? { cmd: info.Config.Cmd } : {}),
        ...(info.Config?.Entrypoint ? { entrypoint: info.Config.Entrypoint } : {}),
      };
    },
    async destroy(params) {
      const docker = await dockerClient();
      const containerId = toDockerLocator(params.locator).containerId;
      console.log(`[docker] disposing container=${containerId.slice(0, 12)}`);
      await docker.containerStop(containerId, { timeout: 3 }).catch(() => {});
      await docker.containerDelete(containerId, { force: true }).catch(() => {});
    },
    async start(params) {
      const docker = await dockerClient();
      const locator = toDockerLocator(params.locator);
      await docker.containerStart(locator.containerId).catch((error) => {
        if (error instanceof Error && error.message.toLowerCase().includes("already started")) {
          return;
        }
        throw error;
      });
    },
    async stop(params) {
      const docker = await dockerClient();
      const locator = toDockerLocator(params.locator);
      await docker.containerStop(locator.containerId, { timeout: 3 }).catch((error) => {
        const message =
          error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        if (message.includes("is not running") || message.includes("already stopped")) {
          return;
        }
        throw error;
      });
    },
    async exec(params) {
      const docker = await dockerClient();
      const locator = toDockerLocator(params.locator);
      const exec = await docker.containerExec(locator.containerId, {
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Cmd: params.cmd,
      });
      if (!exec.Id) throw new Error("docker exec id missing");

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdoutCapture = collectTextOutput(stdout);
      const stderrCapture = collectTextOutput(stderr);
      await docker.execStart(exec.Id, stdout, stderr, { Detach: false, Tty: false });
      const inspect = await docker.execInspect(exec.Id);
      const capturedStdout = stdoutCapture.flush();
      const capturedStderr = stderrCapture.flush();

      return {
        exitCode: inspect.ExitCode ?? 0,
        stdout: capturedStdout,
        stderr: capturedStderr,
        output: `${capturedStdout}${capturedStderr}`,
      };
    },
    async *logs(params) {
      const docker = await dockerClient();
      const locator = toDockerLocator(params.locator);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const queue = new AsyncLineQueue();
      stdout.on("data", (chunk) => queue.push(String(chunk)));
      stderr.on("data", (chunk) => queue.push(String(chunk)));

      const onAbort = () => {
        stdout.destroy();
        stderr.destroy();
        queue.close();
      };
      params.signal.addEventListener("abort", onAbort, { once: true });

      try {
        void docker
          .containerLogs(locator.containerId, stdout, stderr, {
            follow: true,
            stdout: true,
            stderr: true,
            tail: String(params.tail ?? 200),
          })
          .then(() => {
            queue.close();
          })
          .catch((error) => {
            queue.fail(error);
          });

        for await (const line of queue) {
          yield { text: stripAnsi(line) };
        }
      } finally {
        params.signal.removeEventListener("abort", onAbort);
      }
    },
    async status(params) {
      // Docker inspect is not cancelable once issued, so treat abort as a
      // best-effort boundary around the client call.
      throwIfAborted(params.signal);
      const docker = await dockerClient();
      const locator = toDockerLocator(params.locator);
      const info = await docker.containerInspect(locator.containerId);
      throwIfAborted(params.signal);
      const raw = info.State?.Status ?? "unknown";
      const state: DeploymentProviderState =
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
    },
  };
}

export async function inspectDockerContainer(params: {
  locator: DockerDeploymentLocator;
}): Promise<Awaited<ReturnType<DockerSdkClient["containerInspect"]>>> {
  const docker = await dockerClient();
  return await docker.containerInspect(params.locator.containerId);
}

function dedupeStringList(values: Array<string | undefined>): string[] | undefined {
  const unique = [...new Set(values.filter((value): value is string => Boolean(value)))];
  return unique.length > 0 ? unique : undefined;
}

function toDockerLocator(value: unknown): DockerDeploymentLocator {
  if (!value || typeof value !== "object") {
    throw new Error("docker locator must be an object");
  }
  const locator = value as Partial<DockerDeploymentLocator>;
  if (locator.provider !== "docker" || typeof locator.containerId !== "string") {
    throw new Error("invalid docker locator");
  }
  if (locator.containerName != null && typeof locator.containerName !== "string") {
    throw new Error("invalid docker locator containerName");
  }
  return locator as DockerDeploymentLocator;
}

function createDockerHostSyncMounts(): DockerMount[] {
  const runGit = (command: string) =>
    execSync(command, { cwd: process.cwd(), encoding: "utf-8" }).trim();
  const resolvePath = (value: string, baseDir: string) =>
    realpathSync(isAbsolute(value) ? value : join(baseDir, value));

  const repoRoot = realpathSync(runGit("git rev-parse --show-toplevel"));
  const gitDirRaw = runGit("git rev-parse --git-dir");
  const commonDirRaw = runGit("git rev-parse --git-common-dir");

  const gitDirResolved = resolvePath(gitDirRaw, repoRoot);
  const gitDir = statSync(gitDirResolved).isFile()
    ? (() => {
        const gitFile = readFileSync(gitDirResolved, "utf-8").trim();
        const match = gitFile.match(/^gitdir:\s*(.+)$/);
        return match ? resolvePath(match[1], repoRoot) : gitDirResolved;
      })()
    : gitDirResolved;

  return [
    {
      Type: "bind",
      Source: repoRoot,
      Target: DOCKER_HOST_REPO_CHECKOUT_MOUNT_PATH,
      ReadOnly: true,
    },
    {
      Type: "bind",
      Source: gitDir,
      Target: DOCKER_HOST_GIT_DIR_MOUNT_PATH,
      ReadOnly: true,
    },
    {
      Type: "bind",
      Source: resolvePath(commonDirRaw, repoRoot),
      Target: DOCKER_HOST_GIT_COMMON_DIR_MOUNT_PATH,
      ReadOnly: true,
    },
  ];
}

function createDockerPnpmStoreMount(): DockerMount {
  return {
    Type: "volume",
    Source: DOCKER_PNPM_STORE_VOLUME_NAME,
    Target: DOCKER_PNPM_STORE_MOUNT_PATH,
  };
}

function mergeDockerMounts(mounts: Array<DockerMount | undefined>): DockerMount[] | undefined {
  const merged = new Map<string, DockerMount>();
  for (const mount of mounts) {
    if (!mount) continue;
    const key = `${mount.Target ?? ""}:${mount.Type ?? ""}`;
    merged.set(key, mount);
  }
  return merged.size > 0 ? [...merged.values()] : undefined;
}

function normalizeInspectName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("/") ? value.slice(1) : value;
}

function serializeDockerRuntimeMetadata(value: DockerDeploymentOpts) {
  return JSON.stringify(value);
}

function parseDockerRuntimeMetadata(raw: string | undefined): DockerDeploymentOpts {
  if (!raw) {
    throw new Error("docker runtime metadata missing");
  }
  const parsed = withDefaultDockerOpts(JSON.parse(raw) as DockerDeploymentOpts);
  if (!parsed.slug) {
    throw new Error("docker runtime metadata missing slug");
  }
  return parsed;
}

function withDefaultDockerOpts(value: DockerDeploymentOpts): DockerDeploymentOpts {
  return {
    rootfsSurvivesRestart: value.rootfsSurvivesRestart ?? true,
    env: value.env ? { ...value.env } : undefined,
    ...value,
  };
}

function createLineReader(onLine: (line: string) => void) {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) return;
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) onLine(line);
      }
    },
    flush() {
      const line = buffer.replace(/\r$/, "");
      buffer = "";
      if (line.length > 0) onLine(line);
    },
  };
}

class AsyncLineQueue implements AsyncIterable<string> {
  private readonly lines: string[] = [];
  private readonly waiters: Array<(value: IteratorResult<string>) => void> = [];
  private readonly reader = createLineReader((line) => this.enqueue(line));
  private closed = false;
  private failure: unknown;

  push(chunk: string) {
    this.reader.push(chunk);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.reader.flush();
    this.flushWaiters();
  }

  fail(error: unknown) {
    this.failure = error;
    this.closed = true;
    this.flushWaiters();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = await this.next();
      if (next.done) {
        if (this.failure) throw this.failure;
        return;
      }
      yield next.value;
    }
  }

  private enqueue(line: string) {
    if (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: false, value: line });
      return;
    }
    this.lines.push(line);
  }

  private async next(): Promise<IteratorResult<string>> {
    if (this.lines.length > 0) {
      return { done: false, value: this.lines.shift()! };
    }
    if (this.closed) {
      return { done: true, value: undefined };
    }

    return await new Promise<IteratorResult<string>>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private flushWaiters() {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }
  }
}
