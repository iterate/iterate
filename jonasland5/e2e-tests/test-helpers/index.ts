import { CaddyClient } from "@accelerated-software-development/caddy-api-client";
import { DockerClient } from "@docker/node-sdk";
import { request as httpRequest } from "node:http";
import { PassThrough } from "node:stream";
import {
  createServicesClient,
  type ServicesClient,
} from "../../sandbox/services/services-service.ts";
import {
  createClient as createPidnapClient,
  type Client as PidnapClient,
} from "../../../packages/pidnap/src/api/client.ts";
export {
  mockEgressProxy,
  type MockEgressProxy,
  type MockEgressRecord,
  type MockEgressWaitForHandle,
} from "./mock-egress-proxy.ts";

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

function exposedPortsMap(exposedPorts?: string[]): Record<string, {}> | undefined {
  if (!exposedPorts || exposedPorts.length === 0) return undefined;
  return Object.fromEntries(exposedPorts.map((port) => [port, {}]));
}

function portBindingsMap(
  exposedPorts?: string[],
): Record<string, Array<{ HostPort: string }>> | undefined {
  if (!exposedPorts || exposedPorts.length === 0) return undefined;
  return Object.fromEntries(exposedPorts.map((port) => [port, [{ HostPort: "" }]]));
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

export async function dockerPing(): Promise<boolean> {
  try {
    const docker = await dockerClient();
    await docker.systemPing();
    return true;
  } catch {
    return false;
  }
}

export async function dockerContainerFixture(params: {
  image: string;
  name?: string;
  env?: Record<string, string> | string[];
  exposedPorts?: string[];
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
        PortBindings: portBindingsMap(params.exposedPorts),
        ExtraHosts: params.extraHosts,
        CapAdd: params.capAdd,
        Binds: params.binds,
        CgroupnsMode: params.cgroupnsMode,
      },
    },
    { name: params.name },
  );

  if (!created.Id) throw new Error("docker container create id missing");
  await docker.containerStart(created.Id);

  return {
    containerId: created.Id,
    async publishedPort(params: { containerPort: string }) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const inspect = await docker.containerInspect(created.Id);
        const mapping = inspect.NetworkSettings?.Ports?.[params.containerPort];
        const hostPort = mapping?.[0]?.HostPort;
        if (hostPort) return Number(hostPort);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`No published port for ${params.containerPort} on container ${created.Id}`);
    },
    async logs() {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdoutCapture = captureOutput(stdout);
      const stderrCapture = captureOutput(stderr);

      await docker.containerLogs(created.Id, stdout, stderr, {
        stdout: true,
        stderr: true,
        tail: "all",
      });

      return `${stdoutCapture.flush()}${stderrCapture.flush()}`;
    },
    async [Symbol.asyncDispose]() {
      await docker.containerStop(created.Id, { timeout: 3 }).catch(() => {});
      await docker.containerDelete(created.Id, { force: true }).catch(() => {});
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
  const timeoutMs = params.timeoutMs ?? 45_000;
  const result = await params.client.processes.waitForRunning({
    target: params.target,
    timeoutMs,
    pollIntervalMs: 250,
    includeLogs: true,
    logTailLines: 120,
  });

  if (result.state === "running") return;

  throw new Error(
    `pidnap process "${String(params.target)}" did not become running (state=${result.state}, elapsedMs=${String(result.elapsedMs)}, restarts=${String(result.restarts)})\n${result.logs ?? ""}`,
  );
}

async function waitForServicesReady(params: {
  client: ServicesClient;
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
  throw new Error("timed out waiting for services service");
}

export interface ProjectDeployment {
  ports: {
    ingress: number;
  };
  pidnap: PidnapClient;
  caddy: CaddyClient;
  services: ServicesClient;
  ingressUrl(): Promise<string>;
  exec(params: { cmd: string[] }): Promise<{ exitCode: number; output: string }>;
  logs(): Promise<string>;
  waitForHealthyWithLogs(params: { url: string }): Promise<void>;
  waitForCaddyHealthy(params?: { timeoutMs?: number }): Promise<void>;
  waitForPidnapHostRoute(params?: { timeoutMs?: number }): Promise<void>;
  assertIptablesRedirect(): Promise<void>;
  waitForPidnapProcessRunning(params: {
    target: string | number;
    timeoutMs?: number;
  }): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export type SandboxFixture = ProjectDeployment;

export async function waitForHealthyWithLogs(params: {
  url: string;
  deployment: Pick<ProjectDeployment, "logs">;
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
  deployment: Pick<ProjectDeployment, "exec">;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const proxiedList = await params.deployment
      .exec({
        cmd: [
          "sh",
          "-ec",
          "curl -fsS -X POST -H 'Host: pidnap.iterate.localhost' -H 'Content-Type: application/json' --data '{}' http://127.0.0.1/rpc/processes/list",
        ],
      })
      .catch(() => ({ exitCode: 1, output: "" }));

    if (proxiedList.exitCode === 0 && proxiedList.output.includes('"name":"caddy"')) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("timed out waiting for pidnap host route");
}

export async function assertIptablesRedirect(params: {
  deployment: Pick<ProjectDeployment, "exec">;
}): Promise<void> {
  const natRules = await params.deployment.exec({
    cmd: ["sh", "-ec", "iptables -t nat -S OUTPUT"],
  });
  if (natRules.exitCode !== 0) {
    throw new Error(`failed to inspect iptables nat rules:\n${natRules.output}`);
  }
  if (!natRules.output.includes("--dport 80 -j REDIRECT --to-ports 80")) {
    throw new Error(`missing iptables redirect for :80:\n${natRules.output}`);
  }
  if (!natRules.output.includes("--dport 443 -j REDIRECT --to-ports 443")) {
    throw new Error(`missing iptables redirect for :443:\n${natRules.output}`);
  }

  const intercepted = await params.deployment.exec({
    cmd: ["sh", "-ec", "curl -fsS http://example.com/"],
  });
  if (intercepted.exitCode !== 0 || intercepted.output.trim() !== "caddy ok") {
    throw new Error(`expected intercepted egress to return caddy ok:\n${intercepted.output}`);
  }
}

export async function loadCaddyConfigForMockUpstream(params: {
  caddyClient: CaddyClient;
  upstreamDial: string;
  upstreamHost: string;
}): Promise<void> {
  const payload = {
    admin: { listen: "0.0.0.0:2019" },
    apps: {
      tls: {
        automation: {
          policies: [
            {
              subjects: [params.upstreamHost],
              issuers: [{ module: "internal" }],
            },
          ],
        },
      },
      http: {
        servers: {
          srv80: {
            listen: [":80"],
            routes: [
              {
                match: [{ host: ["pidnap.iterate.localhost"] }],
                handle: [
                  {
                    handler: "reverse_proxy",
                    upstreams: [{ dial: "127.0.0.1:9876" }],
                  },
                ],
                terminal: true,
              },
              {
                match: [{ host: ["services.iterate.localhost"] }],
                handle: [
                  {
                    handler: "reverse_proxy",
                    upstreams: [{ dial: "127.0.0.1:8777" }],
                  },
                ],
                terminal: true,
              },
              {
                match: [{ host: ["caddy-admin.iterate.localhost"] }],
                handle: [
                  {
                    handler: "reverse_proxy",
                    upstreams: [{ dial: "127.0.0.1:2019" }],
                  },
                ],
                terminal: true,
              },
              {
                match: [{ host: [params.upstreamHost] }],
                handle: [
                  {
                    handler: "reverse_proxy",
                    upstreams: [{ dial: params.upstreamDial }],
                  },
                ],
                terminal: true,
              },
              {
                handle: [{ handler: "static_response", body: "caddy ok", status_code: 200 }],
                terminal: true,
              },
            ],
          },
          srv443: {
            listen: [":443"],
            routes: [
              {
                match: [{ host: [params.upstreamHost] }],
                handle: [
                  {
                    handler: "reverse_proxy",
                    upstreams: [{ dial: params.upstreamDial }],
                  },
                ],
                terminal: true,
              },
              {
                handle: [{ handler: "static_response", body: "caddy ok", status_code: 200 }],
                terminal: true,
              },
            ],
          },
        },
      },
    },
  };

  const response = await params.caddyClient.request("/load", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(
      `failed to apply caddy /load config: ${response.status} ${response.statusText}`,
    );
  }
}

export async function projectDeployment(params: {
  image: string;
  name?: string;
  extraHosts?: string[];
  capAdd?: string[];
  env?: Record<string, string> | string[];
}): Promise<ProjectDeployment> {
  const exposedPorts = ["80/tcp"];
  const capAdd = params.capAdd ?? ["NET_ADMIN"];
  const container = await dockerContainerFixture({
    image: params.image,
    name: params.name,
    env: params.env,
    exposedPorts,
    extraHosts: params.extraHosts,
    capAdd,
  });

  const ports = {
    ingress: await container.publishedPort({ containerPort: "80/tcp" }),
  };
  const ingressBaseUrl = `http://127.0.0.1:${String(ports.ingress)}`;

  const pidnap = createPidnapClient({
    url: `${ingressBaseUrl}/rpc`,
    fetch: createHostRoutedFetch({
      ingressBaseUrl,
      hostHeader: "pidnap.iterate.localhost",
    }),
  });
  const caddy = createCaddyApiClient({
    adminUrl: ingressBaseUrl,
    hostHeader: "caddy-admin.iterate.localhost",
  });
  const services = createServicesClient({
    url: `${ingressBaseUrl}/rpc`,
    fetch: createHostRoutedFetch({
      ingressBaseUrl,
      hostHeader: "services.iterate.localhost",
    }),
  });

  await waitForHttpOk({
    url: `${ingressBaseUrl}/`,
    timeoutMs: 45_000,
  });
  await waitForPidnapProcessRunning({
    client: pidnap,
    target: "caddy",
    timeoutMs: 45_000,
  });
  await waitForServicesReady({
    client: services,
    timeoutMs: 45_000,
  });

  let deployment: ProjectDeployment;
  deployment = {
    ports,
    pidnap,
    caddy,
    services,
    ingressUrl: async () => ingressBaseUrl,
    exec: async ({ cmd }) => await execInContainer({ containerId: container.containerId, cmd }),
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
    async [Symbol.asyncDispose]() {
      await container[Symbol.asyncDispose]();
    },
  };
  return deployment;
}

export const sandboxFixture = projectDeployment;
