import { request as httpRequest } from "node:http";
import { PassThrough } from "node:stream";
import { CaddyClient } from "@accelerated-software-development/caddy-api-client";
import { DockerClient } from "@docker/node-sdk";
import { createRegistryClient, type RegistryClient } from "@iterate-com/registry-service/client";
import { createClient as createPidnapClient, type Client as PidnapClient } from "pidnap/client";

let dockerClientPromise: Promise<DockerClient> | undefined;

async function dockerClient(): Promise<DockerClient> {
  dockerClientPromise ??= DockerClient.fromDockerConfig();
  return await dockerClientPromise;
}

function toEnvArray(env?: Record<string, string> | string[]): string[] | undefined {
  if (!env) return undefined;
  if (Array.isArray(env)) return env;
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

function toEnvRecord(env?: Record<string, string> | string[]): Record<string, string> {
  if (!env) return {};
  if (!Array.isArray(env)) return { ...env };
  const entries = env
    .map((entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex <= 0) return undefined;
      const key = entry.slice(0, separatorIndex).trim();
      if (key.length === 0) return undefined;
      const value = entry.slice(separatorIndex + 1);
      return [key, value] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry !== undefined);
  return Object.fromEntries(entries);
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

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
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

export type HostRequestParams = {
  host: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
};

function withBody(params: HostRequestParams): { body: string | undefined; headers: Headers } {
  const headers = new Headers(params.headers);
  const body = params.json === undefined ? params.body : JSON.stringify(params.json);

  if (params.json !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (body !== undefined) {
    headers.set("content-length", Buffer.byteLength(body, "utf-8").toString());
  }

  return { body, headers };
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
    const body = await bodyInitToString(options.body);

    return await new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        url,
        {
          method,
          headers: Object.fromEntries(headers.entries()),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on("end", () => {
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              if (Array.isArray(value)) {
                for (const entry of value) {
                  responseHeaders.append(key, entry);
                }
                continue;
              }
              responseHeaders.set(key, String(value));
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 0,
                statusText: res.statusMessage ?? "",
                headers: responseHeaders,
              }),
            );
          });
        },
      );
      req.on("error", reject);
      if (body !== undefined) {
        req.write(body);
      }
      req.end();
    });
  };

  return caddy;
}

function createHostRoutedFetch(params: {
  ingressBaseUrl: string;
  hostHeader: string;
}): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestUrl = new URL(request.url);
    const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, params.ingressBaseUrl);
    const method = request.method.toUpperCase();
    const headers = new Headers(request.headers);
    headers.set("host", params.hostHeader);
    headers.delete("content-length");
    const body = method === "GET" || method === "HEAD" ? undefined : await request.clone().text();
    if (body !== undefined) {
      headers.set("content-length", Buffer.byteLength(body, "utf-8").toString());
    }

    return await new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        targetUrl,
        {
          method,
          headers: Object.fromEntries(headers.entries()),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on("end", () => {
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              if (Array.isArray(value)) {
                for (const entry of value) {
                  responseHeaders.append(key, entry);
                }
                continue;
              }
              responseHeaders.set(key, String(value));
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 0,
                statusText: res.statusMessage ?? "",
                headers: responseHeaders,
              }),
            );
          });
        },
      );

      req.on("error", reject);
      if (body !== undefined) {
        req.write(body);
      }
      req.end();
    });
  };
}

async function ingressRequest(
  params: {
    ingressBaseUrl: string;
  } & HostRequestParams,
): Promise<Response> {
  const targetUrl = new URL(params.path, params.ingressBaseUrl);
  const method = (
    params.method ?? (params.json === undefined && params.body === undefined ? "GET" : "POST")
  ).toUpperCase();
  const { body, headers } = withBody(params);
  headers.set("host", params.host);

  return await new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      targetUrl,
      {
        method,
        headers: Object.fromEntries(headers.entries()),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const entry of value) {
                responseHeaders.append(key, entry);
              }
              continue;
            }
            responseHeaders.set(key, String(value));
          }

          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? "",
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

async function waitForHostRouteViaIngress(params: {
  ingressBaseUrl: string;
  host: string;
  path: string;
  timeoutMs?: number;
  readyStatus?: "ok" | "lt400";
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  const readyStatus = params.readyStatus ?? "ok";

  while (Date.now() < deadline) {
    const response = await ingressRequest({
      ingressBaseUrl: params.ingressBaseUrl,
      host: params.host,
      path: params.path,
    }).catch(() => undefined);

    if (
      response &&
      ((readyStatus === "ok" && response.ok) || (readyStatus === "lt400" && response.status < 400))
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`timed out waiting for host route ${params.host}${params.path}`);
}

async function waitForDirectHttpViaContainer(params: {
  deployment: Pick<ProjectDeployment, "exec">;
  url: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await params.deployment
      .exec(`curl -fsS '${params.url}' >/dev/null`)
      .catch(() => ({ exitCode: 1, output: "" }));
    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for direct http ${params.url}`);
}

function createOrpcRpcHostClient<TContract extends AnyContractRouter>(params: {
  ingressBaseUrl: string;
  host: string;
  manifest: ServiceManifestLike<TContract>;
}): ContractRouterClient<TContract> {
  return createOrpcRpcServiceClient({
    env: {},
    manifest: params.manifest,
    url: `${params.ingressBaseUrl}/orpc`,
    fetch: createHostRoutedFetch({
      ingressBaseUrl: params.ingressBaseUrl,
      hostHeader: params.host,
    }),
  });
}

function createOrdersClient(params: { ingressBaseUrl: string }): OrdersClient {
  return createOrpcRpcHostClient({
    ingressBaseUrl: params.ingressBaseUrl,
    host: "orders.iterate.localhost",
    manifest: ordersServiceManifest,
  });
}

function createEventsClient(params: { ingressBaseUrl: string }): EventsClient {
  return createOrpcRpcHostClient({
    ingressBaseUrl: params.ingressBaseUrl,
    host: "events.iterate.localhost",
    manifest: eventsServiceManifest,
  });
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
}) {
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

  return {
    containerId: createdId,
    async publishedPort(params: { containerPort: string }) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const inspect = await docker.containerInspect(createdId);
        const mapping = inspect.NetworkSettings?.Ports?.[params.containerPort];
        const hostPort = mapping?.[0]?.HostPort;
        if (hostPort) return Number(hostPort);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`No published port for ${params.containerPort} on container ${createdId}`);
    },
    async logs() {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdoutCapture = captureOutput(stdout);
      const stderrCapture = captureOutput(stderr);

      await docker.containerLogs(createdId, stdout, stderr, {
        stdout: true,
        stderr: true,
        tail: "all",
      });

      return `${stdoutCapture.flush()}${stderrCapture.flush()}`;
    },
    async restart() {
      await docker.containerStop(createdId, { timeout: 10 }).catch(() => {});
      await docker.containerStart(createdId);
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const inspect = await docker.containerInspect(createdId);
        if (inspect.State?.Running) return;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new Error(`container failed to restart: ${createdId}`);
    },
    async [Symbol.asyncDispose]() {
      await docker.containerStop(createdId, { timeout: 3 }).catch(() => {});
      await docker.containerDelete(createdId, { force: true }).catch(() => {});
    },
  };
}

export async function execInContainer(params: {
  containerId: string;
  cmd: string[];
}): Promise<{ exitCode: number; output: string }> {
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

export async function waitForHttpOk(params: { url: string; timeoutMs?: number }): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 10_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(params.url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`timed out waiting for healthy endpoint: ${params.url}`);
}

export async function waitForPidnapProcessRunning(params: {
  client: PidnapClient;
  target: string | number;
  timeoutMs?: number;
}): Promise<void> {
  const processSlug = typeof params.target === "string" ? params.target : String(params.target);
  const timeoutMs = params.timeoutMs ?? 45_000;
  const result = await params.client.processes.waitForRunning({
    processSlug,
    timeoutMs,
    pollIntervalMs: 250,
    includeLogs: true,
    logTailLines: 120,
  });

  if (result.state === "running") return;

  throw new Error(
    `pidnap process "${processSlug}" did not become running (state=${result.state}, elapsedMs=${String(result.elapsedMs)}, restarts=${String(result.restarts)})\n${result.logs ?? ""}`,
  );
}

async function waitForPidnapManagerReady(params: {
  client: PidnapClient;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await params.client.manager.status();
      return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error("timed out waiting for pidnap manager");
}

async function waitForRegistryReady(params: {
  client: RegistryClient;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await params.client.routes.caddyLoadInvocation({ apply: false });
      return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("timed out waiting for registry service");
}

async function waitForHostRouteViaContainer(params: {
  containerId: string;
  host: string;
  path: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await execInContainer({
      containerId: params.containerId,
      cmd: ["curl", "-fsS", "-H", `Host: ${params.host}`, `http://127.0.0.1${params.path}`],
    }).catch(() => ({ exitCode: 1, output: "" }));
    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`timed out waiting for host route ${params.host}${params.path}`);
}

export interface DeploymentRuntime {
  ports: {
    ingress: number;
  };
  pidnap: PidnapClient;
  caddy: CaddyClient;
  registry: RegistryClient;
  ingressUrl(): Promise<string>;
  exec(cmd: string | string[]): Promise<{ exitCode: number; output: string }>;
  request(params: HostRequestParams): Promise<Response>;
  waitForHostRoute(params: {
    host: string;
    path: string;
    timeoutMs?: number;
    readyStatus?: "ok" | "lt400";
  }): Promise<void>;
  startOnDemandProcess(processName: OnDemandProcessName): Promise<void>;
  waitForDocsSources(expectedHosts: string[]): Promise<DocsSourcesPayload>;
  logs(): Promise<string>;
  waitForHealthyWithLogs(params: { url: string }): Promise<void>;
  waitForCaddyHealthy(params?: { timeoutMs?: number }): Promise<void>;
  waitForPidnapHostRoute(params?: { timeoutMs?: number }): Promise<void>;
  assertIptablesRedirect(): Promise<void>;
  restart(): Promise<void>;
  waitForPidnapProcessRunning(params: {
    target: string | number;
    timeoutMs?: number;
  }): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export type SandboxFixture = DeploymentRuntime;

export async function waitForHealthyWithLogs(params: {
  url: string;
  deployment: Pick<DeploymentRuntime, "logs">;
}): Promise<void> {
  try {
    await waitForHttpOk({
      url: params.url,
      timeoutMs: 45_000,
    });
  } catch (error) {
    const logs = await params.deployment.logs().catch(() => "(container logs unavailable)");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\ncontainer logs:\n${logs}`,
    );
  }
}

export async function waitForPidnapHostRoute(params: {
  deployment: Pick<DeploymentRuntime, "exec">;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const proxiedList = await params.deployment
      .exec(
        "curl -fsS -X POST -H 'Host: pidnap.iterate.localhost' -H 'Content-Type: application/json' --data '{}' http://127.0.0.1/rpc/processes/list",
      )
      .catch(() => ({ exitCode: 1, output: "" }));

    if (proxiedList.exitCode === 0 && proxiedList.output.includes('"name":"caddy"')) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("timed out waiting for pidnap host route");
}

export async function assertIptablesRedirect(params: {
  deployment: Pick<DeploymentRuntime, "exec">;
}): Promise<void> {
  const natRules = await params.deployment.exec("sudo iptables -t nat -S OUTPUT");
  if (natRules.exitCode !== 0) {
    throw new Error(`failed to inspect iptables nat rules:\n${natRules.output}`);
  }
  if (!natRules.output.includes("--dport 80 -j REDIRECT --to-ports 80")) {
    throw new Error(`missing iptables redirect for :80:\n${natRules.output}`);
  }
  if (!natRules.output.includes("--dport 443 -j REDIRECT --to-ports 443")) {
    throw new Error(`missing iptables redirect for :443:\n${natRules.output}`);
  }
}

export interface DockerDeploymentLocator {
  provider: "docker";
  containerId: string;
  name?: string;
}

type ContainerRuntimeHandle = {
  containerId: string;
  publishedPort(params: { containerPort: string }): Promise<number>;
  logs(): Promise<string>;
  restart(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

async function attachToExistingContainer(
  locator: DockerDeploymentLocator,
): Promise<ContainerRuntimeHandle> {
  const docker = await dockerClient();
  const inspect = await docker.containerInspect(locator.containerId);
  const resolvedId = inspect.Id;
  if (!resolvedId) {
    throw new Error(`docker attach failed: could not inspect container ${locator.containerId}`);
  }

  return {
    containerId: resolvedId,
    async publishedPort(params: { containerPort: string }) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const latest = await docker.containerInspect(resolvedId);
        const mapping = latest.NetworkSettings?.Ports?.[params.containerPort];
        const hostPort = mapping?.[0]?.HostPort;
        if (hostPort) return Number(hostPort);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`No published port for ${params.containerPort} on container ${resolvedId}`);
    },
    async logs() {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdoutCapture = captureOutput(stdout);
      const stderrCapture = captureOutput(stderr);
      await docker.containerLogs(resolvedId, stdout, stderr, {
        stdout: true,
        stderr: true,
        tail: "all",
      });
      return `${stdoutCapture.flush()}${stderrCapture.flush()}`;
    },
    async restart() {
      await docker.containerStop(resolvedId, { timeout: 10 }).catch(() => {});
      await docker.containerStart(resolvedId);
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const latest = await docker.containerInspect(resolvedId);
        if (latest.State?.Running) return;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new Error(`container failed to restart: ${resolvedId}`);
    },
    async [Symbol.asyncDispose]() {},
  };
}

async function createRuntimeFromContainer(params: {
  container: ContainerRuntimeHandle;
  requestedEnv: Record<string, string>;
  writePublicBaseEnv: boolean;
  destroyOnDispose: boolean;
}): Promise<DeploymentRuntime> {
  const { container, requestedEnv, writePublicBaseEnv, destroyOnDispose } = params;
  const ports = {
    ingress: await container.publishedPort({ containerPort: "80/tcp" }),
  };
  let ingressBaseUrl = `http://127.0.0.1:${String(ports.ingress)}`;
  let pidnap = createPidnapClient({
    url: `${ingressBaseUrl}/rpc`,
    fetch: createHostRoutedFetch({
      ingressBaseUrl,
      hostHeader: "pidnap.iterate.localhost",
    }),
  });
  let caddy = createCaddyApiClient({
    adminUrl: ingressBaseUrl,
    hostHeader: "caddy.iterate.localhost",
  });
  let registry = createRegistryClient({
    url: `${ingressBaseUrl}/orpc`,
    fetch: createHostRoutedFetch({
      ingressBaseUrl,
      hostHeader: "registry.iterate.localhost",
    }),
  });
  let orders = createOrdersClient({ ingressBaseUrl });
  let events = createEventsClient({ ingressBaseUrl });

  const resolvePublicBaseUrlType = (fallback?: string): "prefix" | "subdomain" => {
    const candidate = requestedEnv.ITERATE_PUBLIC_BASE_URL_TYPE ?? fallback;
    return candidate === "subdomain" ? "subdomain" : "prefix";
  };

  const updateIngressPublicBaseUrl = async (): Promise<void> => {
    if (!writePublicBaseEnv) return;
    await waitForPidnapManagerReady({ client: pidnap, timeoutMs: 45_000 });

    const desiredBaseUrl =
      requestedEnv.ITERATE_PUBLIC_BASE_URL ?? `http://iterate.localhost:${String(ports.ingress)}`;
    const currentRegistry = await pidnap.processes.get({
      target: "registry",
      includeEffectiveEnv: false,
    });
    const desiredType = resolvePublicBaseUrlType(
      currentRegistry.definition.env?.ITERATE_PUBLIC_BASE_URL_TYPE,
    );
    const currentEnv = currentRegistry.definition.env ?? {};
    const nextEnv = {
      ...currentEnv,
      ITERATE_PUBLIC_BASE_URL: desiredBaseUrl,
      ITERATE_PUBLIC_BASE_URL_TYPE: desiredType,
    };

    const envFileWrite = await execInContainer({
      containerId: container.containerId,
      cmd: [
        "sh",
        "-ec",
        [
          "mkdir -p /opt/jonasland-sandbox",
          `printf 'ITERATE_PUBLIC_BASE_URL=%s\\nITERATE_PUBLIC_BASE_URL_TYPE=%s\\n' ${shellSingleQuote(desiredBaseUrl)} ${shellSingleQuote(desiredType)} > /opt/jonasland-sandbox/.env`,
        ].join(" && "),
      ],
    });
    if (envFileWrite.exitCode !== 0) {
      throw new Error(`failed writing /opt/jonasland-sandbox/.env:\n${envFileWrite.output}`);
    }

    const needsUpdate =
      currentEnv.ITERATE_PUBLIC_BASE_URL !== desiredBaseUrl ||
      currentEnv.ITERATE_PUBLIC_BASE_URL_TYPE !== desiredType;

    if (!needsUpdate) return;

    await pidnap.processes.updateConfig({
      processSlug: "registry",
      definition: {
        ...currentRegistry.definition,
        env: nextEnv,
      },
      restartImmediately: true,
    });

    await waitForPidnapProcessRunning({
      client: pidnap,
      target: "registry",
      timeoutMs: 60_000,
    });
  };

  const waitForRuntimeReady = async () => {
    await waitForHttpOk({
      url: `${ingressBaseUrl}/`,
      timeoutMs: 45_000,
    });
    for (const processName of ["caddy", "registry", "events"] as const) {
      await waitForPidnapProcessRunning({
        client: pidnap,
        target: processName,
        timeoutMs: 60_000,
      });
    }

    await waitForRegistryReady({
      client: registry,
      timeoutMs: 90_000,
    });

    await waitForHostRouteViaIngress({
      ingressBaseUrl,
      host: "events.iterate.localhost",
      path: "/api/service/health",
      timeoutMs: 60_000,
    });
  };

  const deployment: DeploymentRuntime = {
    ports,
    pidnap,
    caddy,
    registry,
    ingressUrl: async () => ingressBaseUrl,
    exec: async (cmd) => {
      const argv = typeof cmd === "string" ? ["sh", "-ec", cmd] : cmd;
      return await execInContainer({ containerId: container.containerId, cmd: argv });
    },
    request: async (params) =>
      await ingressRequest({
        ingressBaseUrl,
        ...params,
      }),
    waitForHostRoute: async (params) =>
      await waitForHostRouteViaIngress({
        ingressBaseUrl,
        ...params,
      }),
    startOnDemandProcess: async (processName) =>
      await startOnDemandProcessShared({
        deployment,
        processName,
        processConfig: onDemandProcesses[processName],
        waitForHostRoute: async (params) => {
          await deployment.waitForHostRoute(params);
        },
        waitForDirectHttp: async (params) => {
          await waitForDirectHttpViaContainer({
            deployment,
            ...params,
          });
        },
      }),
    waitForDocsSources: async (expectedHosts) =>
      await waitForDocsSourcesShared({
        expectedHosts,
        fetchSources: async () => {
          const response = await deployment
            .request({
              host: "docs.iterate.localhost",
              path: "/api/openapi-sources",
            })
            .catch(() => undefined);
          if (!response?.ok) return undefined;
          return (await response.json().catch(() => undefined)) as DocsSourcesPayload | undefined;
        },
      }),
    logs: async () => await container.logs(),
    waitForHealthyWithLogs: async ({ url }) =>
      await waitForHealthyWithLogs({
        url,
        deployment,
      }),
    waitForCaddyHealthy: async ({ timeoutMs } = {}) => {
      const ingress = await deployment.ingressUrl();
      await waitForHttpOk({
        url: `${ingress}/`,
        timeoutMs: timeoutMs ?? 45_000,
      });
    },
    waitForPidnapHostRoute: async ({ timeoutMs } = {}) =>
      await waitForPidnapHostRoute({
        deployment,
        timeoutMs: timeoutMs ?? 45_000,
      }),
    assertIptablesRedirect: async () => await assertIptablesRedirect({ deployment }),
    waitForPidnapProcessRunning: async ({ target, timeoutMs }) =>
      await waitForPidnapProcessRunning({
        client: pidnap,
        target,
        timeoutMs: timeoutMs ?? 45_000,
      }),
    restart: async () => {
      await container.restart();
      ports.ingress = await container.publishedPort({ containerPort: "80/tcp" });
      ingressBaseUrl = `http://127.0.0.1:${String(ports.ingress)}`;
      pidnap = createPidnapClient({
        url: `${ingressBaseUrl}/rpc`,
        fetch: createHostRoutedFetch({
          ingressBaseUrl,
          hostHeader: "pidnap.iterate.localhost",
        }),
      });
      caddy = createCaddyApiClient({
        adminUrl: ingressBaseUrl,
        hostHeader: "caddy.iterate.localhost",
      });
      registry = createRegistryClient({
        url: `${ingressBaseUrl}/orpc`,
        fetch: createHostRoutedFetch({
          ingressBaseUrl,
          hostHeader: "registry.iterate.localhost",
        }),
      });
      orders = createOrdersClient({ ingressBaseUrl });
      events = createEventsClient({ ingressBaseUrl });
      deployment.pidnap = pidnap;
      deployment.caddy = caddy;
      deployment.registry = registry;
      await updateIngressPublicBaseUrl();
      await waitForRuntimeReady();
    },
    async [Symbol.asyncDispose]() {
      if (!destroyOnDispose) return;
      await container[Symbol.asyncDispose]();
    },
  };

  try {
    await updateIngressPublicBaseUrl();
    await waitForRuntimeReady();
  } catch (error) {
    if (destroyOnDispose) {
      await container[Symbol.asyncDispose]().catch(() => {});
    }
    throw error;
  }

  return deployment;
}

export async function dockerDeploymentRuntimeCreate(params: {
  dockerImage: string;
  name?: string;
  extraHosts?: string[];
  capAdd?: string[];
  env?: Record<string, string> | string[];
  ingressHostPort?: number;
}): Promise<{ runtime: DeploymentRuntime; deploymentLocator: DockerDeploymentLocator }> {
  const requestedEnv = toEnvRecord(params.env);
  const exposedPorts = ["80/tcp"];
  const capAdd = params.capAdd ?? ["NET_ADMIN"];
  const ingressHostPort =
    typeof params.ingressHostPort === "number" && Number.isInteger(params.ingressHostPort)
      ? params.ingressHostPort
      : undefined;
  const container = await dockerContainerFixture({
    image: params.dockerImage,
    name: params.name,
    env: params.env,
    exposedPorts,
    portBindings: ingressHostPort ? { "80/tcp": ingressHostPort } : undefined,
    extraHosts: withDefaultExtraHosts(params.extraHosts),
    capAdd,
  });
  const deploymentLocator: DockerDeploymentLocator = {
    provider: "docker",
    containerId: container.containerId,
    name: params.name,
  };
  const runtime = await createRuntimeFromContainer({
    container,
    requestedEnv,
    writePublicBaseEnv: true,
    destroyOnDispose: true,
  });
  return { runtime, deploymentLocator };
}

export async function dockerDeploymentRuntimeAttach(
  locator: DockerDeploymentLocator,
): Promise<DeploymentRuntime> {
  const container = await attachToExistingContainer(locator);
  return await createRuntimeFromContainer({
    container,
    requestedEnv: {},
    writePublicBaseEnv: false,
    destroyOnDispose: false,
  });
}

export async function createDeployment(params: {
  dockerImage: string;
  name?: string;
  extraHosts?: string[];
  capAdd?: string[];
  env?: Record<string, string> | string[];
  ingressHostPort?: number;
}): Promise<DeploymentRuntime> {
  const result = await dockerDeploymentRuntimeCreate(params);
  return result.runtime;
}

export const dockerDeploymentRuntime = createDeployment;
export const sandboxFixture = createDeployment;
