import { PassThrough } from "node:stream";
import { CaddyClient } from "@accelerated-software-development/caddy-api-client";
import { DockerClient } from "@docker/node-sdk";
import { createRegistryClient, type RegistryClient } from "@iterate-com/registry-service/client";
import pWaitFor from "p-wait-for";
import { createClient as createPidnapClient } from "pidnap/client";
import {
  Deployment,
  waitForHttpOk,
  type DeploymentCommandResult,
  type DeploymentIngressOpts,
  type DeploymentOpts,
} from "./deployment.ts";
import { nodeHttpRequest, shQuote, toEnvRecord } from "./deployment-utils.ts";

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

function withDefaultExtraHosts(extraHosts?: string[]): string[] {
  const merged = ["host.docker.internal:host-gateway", ...(extraHosts ?? [])];
  return [...new Set(merged)];
}

function exposedPortsMap(exposedPorts?: string[]): Record<string, {}> | undefined {
  if (!exposedPorts || exposedPorts.length === 0) return undefined;
  return Object.fromEntries(exposedPorts.map((port) => [port, {}]));
}

function portBindingsMap(
  exposedPorts?: string[],
  hostPorts?: Record<string, string | number>,
): Record<string, Array<{ HostPort: string }>> | undefined {
  if (!exposedPorts || exposedPorts.length === 0) return undefined;
  return Object.fromEntries(
    exposedPorts.map((port) => {
      const hostPort = hostPorts?.[port];
      return [port, [{ HostPort: hostPort === undefined ? "" : String(hostPort) }]];
    }),
  );
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

async function bodyInitToString(
  body: RequestInit["body"] | null | undefined,
): Promise<string | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Blob) return await body.text();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf-8");
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf-8");
  }
  if (body instanceof ReadableStream) {
    const response = new Response(body);
    return await response.text();
  }
  const response = new Response(body);
  return await response.text();
}

function createCaddyApiClient(params: { adminUrl: string; hostHeader?: string }): CaddyClient {
  const adminUrl = params.adminUrl;
  const caddy = new CaddyClient({ adminUrl });

  caddy.request = async (path: string, options: RequestInit = {}): Promise<Response> => {
    const url = new URL(path, adminUrl);
    const method = options.method ?? "GET";
    const headers = new Headers(options.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    headers.delete("sec-fetch-mode");
    headers.delete("sec-fetch-site");
    headers.delete("sec-fetch-dest");
    headers.delete("origin");
    if (params.hostHeader) {
      headers.set("host", params.hostHeader);
    }
    const bodyStr = await bodyInitToString(options.body);
    const body = bodyStr === undefined ? undefined : Buffer.from(bodyStr);

    return await nodeHttpRequest({ url, method, headers, body, buffered: true });
  };

  return caddy;
}

function createHostRoutedFetch(params: {
  ingressBaseUrl: string;
  hostHeader: string;
}): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestUrl = new URL(request.url);
    const url = new URL(`${requestUrl.pathname}${requestUrl.search}`, params.ingressBaseUrl);
    const method = request.method.toUpperCase();
    const headers = new Headers(request.headers);
    headers.set("host", params.hostHeader);
    headers.delete("content-length");
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : Buffer.from(await request.clone().arrayBuffer());
    if (body !== undefined) {
      headers.set("content-length", body.byteLength.toString());
    }

    return await nodeHttpRequest({ url, method, headers, body, buffered: true });
  };
}

export async function dockerContainerFixture(params: {
  image: string;
  name?: string;
  env?: Record<string, string> | string[];
  exposedPorts?: string[];
  portBindings?: Record<string, string | number>;
  extraHosts?: string[];
  capAdd?: string[];
  binds?: string[];
  cgroupnsMode?: "host" | "private";
}): Promise<{ containerId: string }> {
  const docker = await dockerClient();
  const created = await docker.containerCreate(
    {
      Image: params.image,
      Env: toEnvArray(params.env),
      ExposedPorts: exposedPortsMap(params.exposedPorts),
      HostConfig: {
        PortBindings: portBindingsMap(params.exposedPorts, params.portBindings),
        ExtraHosts: params.extraHosts,
        CapAdd: params.capAdd,
        Binds: params.binds,
        CgroupnsMode: params.cgroupnsMode,
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

  return { containerId: createdId };
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

async function attachToExistingContainer(locator: DockerDeploymentLocator): Promise<string> {
  const docker = await dockerClient();
  const inspect = await docker.containerInspect(locator.containerId);
  const resolvedId = inspect.Id;
  if (!resolvedId) {
    throw new Error(`docker attach failed: could not inspect container ${locator.containerId}`);
  }

  return resolvedId;
}

async function getPublishedPort(params: {
  containerId: string;
  containerPort: string;
}): Promise<number> {
  const docker = await dockerClient();
  let resolved: number | undefined;
  await pWaitFor(
    async () => {
      const inspect = await docker.containerInspect(params.containerId);
      const hostPort = inspect.NetworkSettings?.Ports?.[params.containerPort]?.[0]?.HostPort;
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
        message: `No published port for ${params.containerPort} on container ${params.containerId}`,
      },
    },
  );
  return resolved!;
}

async function getContainerLogs(containerId: string): Promise<string> {
  const docker = await dockerClient();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutCapture = captureOutput(stdout);
  const stderrCapture = captureOutput(stderr);
  await docker.containerLogs(containerId, stdout, stderr, {
    stdout: true,
    stderr: true,
    tail: "all",
  });
  return `${stdoutCapture.flush()}${stderrCapture.flush()}`;
}

async function restartContainer(containerId: string): Promise<void> {
  const docker = await dockerClient();
  await docker.containerStop(containerId, { timeout: 10 }).catch(() => {});
  await docker.containerStart(containerId);
  await pWaitFor(
    async () => {
      const inspect = await docker.containerInspect(containerId);
      return inspect.State?.Running === true;
    },
    {
      interval: 150,
      timeout: {
        milliseconds: 20_000,
        message: `container failed to restart: ${containerId}`,
      },
    },
  );
}

async function disposeContainer(containerId: string): Promise<void> {
  const docker = await dockerClient();
  await docker.containerStop(containerId, { timeout: 3 }).catch(() => {});
  await docker.containerDelete(containerId, { force: true }).catch(() => {});
}

async function waitForPidnapManagerReady(params: {
  timeoutMs?: number;
  client: DockerDeployment["pidnap"];
}) {
  await pWaitFor(
    async () => {
      try {
        await params.client.manager.status();
        return true;
      } catch {
        return false;
      }
    },
    {
      interval: 200,
      timeout: {
        milliseconds: params.timeoutMs ?? 45_000,
        message: "timed out waiting for pidnap manager",
      },
    },
  );
}

async function waitForRegistryReady(params: { timeoutMs?: number; client: RegistryClient }) {
  await pWaitFor(
    async () => {
      try {
        await params.client.routes.caddyLoadInvocation({ apply: false });
        return true;
      } catch {
        return false;
      }
    },
    {
      interval: 150,
      timeout: {
        milliseconds: params.timeoutMs ?? 30_000,
        message: "timed out waiting for registry service",
      },
    },
  );
}

async function waitForHostRouteViaIngress(params: {
  ingressBaseUrl: string;
  host: string;
  path: string;
  timeoutMs?: number;
}): Promise<void> {
  const targetUrl = new URL(params.path, params.ingressBaseUrl);
  await pWaitFor(
    async () => {
      const response = await fetch(targetUrl, {
        headers: { Host: params.host },
      }).catch(() => null);
      return response?.ok ?? false;
    },
    {
      interval: 200,
      timeout: {
        milliseconds: params.timeoutMs ?? 45_000,
        message: `timed out waiting for host route ${params.host}${params.path}`,
      },
    },
  );
}

export interface DockerDeploymentLocator {
  provider: "docker";
  containerId: string;
  name?: string;
}

export interface DockerDeploymentOpts extends DeploymentOpts {
  dockerImage?: string;
  extraHosts?: string[];
  capAdd?: string[];
  ingressHostPort?: number;
  managePublicBaseEnv?: boolean;
  disposePolicy?: "delete" | "preserve";
}

export class DockerDeployment extends Deployment<DockerDeploymentOpts, DockerDeploymentLocator> {
  static override implemented = true;

  protected readonly providerName = "docker" as const;
  private containerId: string | null = null;
  private requestedEnv: Record<string, string> = {};
  private managePublicBaseEnv = true;
  private disposePolicy: "delete" | "preserve" = "delete";
  private ingressBaseUrl = "";

  protected override async providerCreate(opts: DockerDeploymentOpts) {
    if (!opts.dockerImage) {
      throw new Error("dockerImage is required");
    }

    this.requestedEnv = toEnvRecord(opts.env);
    this.managePublicBaseEnv = opts.managePublicBaseEnv ?? true;
    this.disposePolicy = opts.disposePolicy ?? "delete";

    const ingressHostPort =
      typeof opts.ingressHostPort === "number" && Number.isInteger(opts.ingressHostPort)
        ? opts.ingressHostPort
        : undefined;

    const created = await dockerContainerFixture({
      image: opts.dockerImage,
      name: opts.name,
      env: opts.env,
      exposedPorts: ["80/tcp"],
      portBindings: ingressHostPort ? { "80/tcp": ingressHostPort } : undefined,
      extraHosts: withDefaultExtraHosts(opts.extraHosts),
      capAdd: opts.capAdd ?? ["NET_ADMIN"],
    });
    this.containerId = created.containerId;

    await this.refreshClients();

    try {
      await this.updateIngressPublicBaseUrlIfNeeded();
      await this.waitForRuntimeReady();
    } catch (error) {
      await this.disposeContainerIfNeeded();
      throw error;
    }

    const locator: DockerDeploymentLocator = {
      provider: "docker",
      containerId: this.requireContainerId(),
      name: opts.name,
    };

    return {
      locator,
      defaultIngressOpts: this.buildDefaultIngressOpts(),
      cleanupOnError: async () => await this.disposeContainerIfNeeded(),
    };
  }

  protected override async providerAttach(
    locator: DockerDeploymentLocator,
    opts: Partial<DockerDeploymentOpts> = {},
  ) {
    this.requestedEnv = {};
    this.managePublicBaseEnv = opts.managePublicBaseEnv ?? false;
    this.disposePolicy = opts.disposePolicy ?? "preserve";

    this.containerId = await attachToExistingContainer(locator);

    await this.refreshClients();

    try {
      await this.updateIngressPublicBaseUrlIfNeeded();
      await this.waitForRuntimeReady();
    } catch (error) {
      this.containerId = null;
      throw error;
    }

    return {
      defaultIngressOpts: this.buildDefaultIngressOpts(),
      cleanupOnError: async () => {},
    };
  }

  protected override async providerRestart(): Promise<void> {
    await restartContainer(this.requireContainerId());
    await this.refreshClients();
    await this.updateIngressPublicBaseUrlIfNeeded();
    await this.waitForRuntimeReady();
  }

  protected override async providerDisposeOwned(): Promise<void> {
    await this.disposeContainerIfNeeded();
  }

  protected override async providerDisposeAttached(): Promise<void> {
    await this.disposeContainerIfNeeded();
  }

  protected override async providerIngressUrl(): Promise<string> {
    if (!this.ingressBaseUrl) {
      throw new Error("docker ingress url not initialized");
    }
    return this.ingressBaseUrl;
  }

  protected override async providerExec(cmd: string | string[]): Promise<DeploymentCommandResult> {
    const argv = typeof cmd === "string" ? ["sh", "-ec", cmd] : cmd;
    return await execInContainer({
      containerId: this.requireContainerId(),
      cmd: argv,
    });
  }

  protected override async providerLogs(): Promise<string> {
    return await getContainerLogs(this.requireContainerId());
  }

  private async refreshClients(): Promise<void> {
    this.ports.ingress = await getPublishedPort({
      containerId: this.requireContainerId(),
      containerPort: "80/tcp",
    });
    this.ingressBaseUrl = `http://127.0.0.1:${String(this.ports.ingress)}`;

    this.pidnap = createPidnapClient({
      url: `${this.ingressBaseUrl}/rpc`,
      fetch: createHostRoutedFetch({
        ingressBaseUrl: this.ingressBaseUrl,
        hostHeader: "pidnap.iterate.localhost",
      }),
    });
    this.caddy = createCaddyApiClient({
      adminUrl: this.ingressBaseUrl,
      hostHeader: "caddy.iterate.localhost",
    });
    this.registry = createRegistryClient({
      url: `${this.ingressBaseUrl}/orpc`,
      fetch: createHostRoutedFetch({
        ingressBaseUrl: this.ingressBaseUrl,
        hostHeader: "registry.iterate.localhost",
      }),
    });
  }

  private async updateIngressPublicBaseUrlIfNeeded(): Promise<void> {
    if (!this.managePublicBaseEnv || !this.containerId) return;
    const containerId = this.containerId;

    await waitForPidnapManagerReady({
      client: this.pidnap,
      timeoutMs: 45_000,
    });

    const desiredBaseUrl =
      this.requestedEnv.ITERATE_PUBLIC_BASE_URL ??
      `http://iterate.localhost:${String(this.ports.ingress)}`;

    const currentRegistry = await this.pidnap.processes.get({
      target: "registry",
      includeEffectiveEnv: false,
    });

    const desiredType =
      this.requestedEnv.ITERATE_PUBLIC_BASE_URL_TYPE ??
      currentRegistry.definition.env?.ITERATE_PUBLIC_BASE_URL_TYPE ??
      "prefix";

    const currentEnv = currentRegistry.definition.env ?? {};
    const nextEnv = {
      ...currentEnv,
      ITERATE_PUBLIC_BASE_URL: desiredBaseUrl,
      ITERATE_PUBLIC_BASE_URL_TYPE: desiredType,
    };

    const needsUpdate =
      currentEnv.ITERATE_PUBLIC_BASE_URL !== desiredBaseUrl ||
      currentEnv.ITERATE_PUBLIC_BASE_URL_TYPE !== desiredType;

    if (!needsUpdate) return;

    const envFileWrite = await execInContainer({
      containerId,
      cmd: [
        "sh",
        "-ec",
        [
          "mkdir -p /opt/jonasland-sandbox",
          `printf 'ITERATE_PUBLIC_BASE_URL=%s\\nITERATE_PUBLIC_BASE_URL_TYPE=%s\\n' ${shQuote(desiredBaseUrl)} ${shQuote(desiredType)} > /opt/jonasland-sandbox/.env`,
        ].join(" && "),
      ],
    });
    if (envFileWrite.exitCode !== 0) {
      throw new Error(`failed writing /opt/jonasland-sandbox/.env:\n${envFileWrite.output}`);
    }

    await this.pidnap.processes.updateConfig({
      processSlug: "registry",
      definition: {
        ...currentRegistry.definition,
        env: nextEnv,
      },
      restartImmediately: true,
    });

    await this.waitForPidnapProcessRunning({
      target: "registry",
      timeoutMs: 60_000,
    });
  }

  private async waitForRuntimeReady(): Promise<void> {
    await waitForHttpOk({
      url: `${this.ingressBaseUrl}/`,
      timeoutMs: 45_000,
    });

    for (const processName of ["caddy", "registry", "events"] as const) {
      await this.waitForPidnapProcessRunning({
        target: processName,
        timeoutMs: 60_000,
      });
    }

    await waitForRegistryReady({
      client: this.registry,
      timeoutMs: 90_000,
    });

    await waitForHostRouteViaIngress({
      ingressBaseUrl: this.ingressBaseUrl,
      host: "events.iterate.localhost",
      path: "/api/service/health",
      timeoutMs: 60_000,
    });
  }

  private requireContainerId(): string {
    if (!this.containerId) {
      throw new Error("docker deployment is not initialized");
    }
    return this.containerId;
  }

  private buildDefaultIngressOpts(): DeploymentIngressOpts {
    const runtimeIngress = new URL(this.ingressBaseUrl);
    const port = runtimeIngress.port || (runtimeIngress.protocol === "https:" ? "443" : "80");
    return {
      publicBaseUrl: `http://iterate.localhost:${port}`,
      publicBaseUrlType: "subdomain",
      ingressProxyTargetUrl: this.ingressBaseUrl,
    };
  }

  private async disposeContainerIfNeeded(): Promise<void> {
    const containerId = this.containerId;
    this.containerId = null;
    if (!containerId) return;
    if (this.disposePolicy === "preserve") return;
    await disposeContainer(containerId).catch(() => {});
  }

  static async create(opts: DockerDeploymentOpts): Promise<DockerDeployment> {
    const deployment = new DockerDeployment();
    await deployment.create(opts);
    return deployment;
  }

  static createWithOpts(baseOpts: Partial<DockerDeploymentOpts>) {
    const create = async (override?: Partial<DockerDeploymentOpts>): Promise<DockerDeployment> => {
      const merged = {
        ...(baseOpts as object),
        ...((override ?? {}) as object),
      } as DockerDeploymentOpts;
      return await DockerDeployment.create(merged);
    };
    return Object.assign(create, { create });
  }
}
