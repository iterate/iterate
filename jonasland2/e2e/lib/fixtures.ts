import { DockerClient } from "@docker/node-sdk";
import { getLocal } from "mockttp";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { WebSocketServer } from "ws";

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
        CgroupnsMode: "host",
        Privileged: true,
      },
    },
    { name: params.name },
  );

  if (!created.Id) throw new Error("docker container create id missing");

  await docker.containerStart(created.Id);

  return {
    containerId: created.Id,
    async publishedPort(containerPort: string) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const inspect = await docker.containerInspect(created.Id);
        const mapping = inspect.NetworkSettings?.Ports?.[containerPort];
        const hostPort = mapping?.[0]?.HostPort;
        if (hostPort) return Number(hostPort);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`No published port for ${containerPort} on container ${created.Id}`);
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
    async restart() {
      await docker.containerStop(created.Id, { timeout: 10 }).catch(() => {});
      await docker.containerStart(created.Id);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const inspect = await docker.containerInspect(created.Id);
        if (inspect.State?.Running) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`container failed to restart: ${created.Id}`);
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

type WebSocketHandshakeRecord = {
  pathname: string;
  headers: IncomingHttpHeaders;
};
type WaitForHandshakeOptions = {
  pathname?: string;
  timeoutMs?: number;
  predicate?: (record: WebSocketHandshakeRecord) => boolean;
};

export async function webSocketEchoServerFixture() {
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ server: httpServer });
  const handshakes: WebSocketHandshakeRecord[] = [];
  const pendingWaiters: Array<{
    resolve: (record: WebSocketHandshakeRecord) => void;
    reject: (error: Error) => void;
    pathname?: string;
    predicate?: (record: WebSocketHandshakeRecord) => boolean;
    timeout: NodeJS.Timeout;
  }> = [];

  wsServer.on("connection", (socket, request) => {
    const record: WebSocketHandshakeRecord = {
      pathname: new URL(request.url || "/", "http://local").pathname,
      headers: request.headers,
    };
    handshakes.push(record);

    const waiters = [...pendingWaiters];
    for (const waiter of waiters) {
      const pathnameOk = waiter.pathname ? waiter.pathname === record.pathname : true;
      const predicateOk = waiter.predicate ? waiter.predicate(record) : true;
      if (!pathnameOk || !predicateOk) continue;
      clearTimeout(waiter.timeout);
      const index = pendingWaiters.indexOf(waiter);
      if (index >= 0) pendingWaiters.splice(index, 1);
      waiter.resolve(record);
    }

    socket.on("message", (raw) => {
      socket.send(`echo:${String(raw)}`);
    });
  });

  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    wsServer.close();
    httpServer.close();
    throw new Error("websocket fixture failed to bind");
  }

  return {
    url: `ws://host.docker.internal:${String(address.port)}`,
    async waitForHandshake(options?: WaitForHandshakeOptions) {
      const timeoutMs = options?.timeoutMs ?? 7_500;
      const existing = handshakes.find((record) => {
        const pathnameOk = options?.pathname ? record.pathname === options.pathname : true;
        const predicateOk = options?.predicate ? options.predicate(record) : true;
        return pathnameOk && predicateOk;
      });
      if (existing) return existing;

      return await new Promise<WebSocketHandshakeRecord>((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = pendingWaiters.findIndex((waiter) => waiter.timeout === timeout);
          if (index >= 0) pendingWaiters.splice(index, 1);
          reject(
            new Error(
              `Timed out waiting for websocket handshake pathname=${options?.pathname ?? "(any)"}`,
            ),
          );
        }, timeoutMs);

        pendingWaiters.push({
          resolve,
          reject,
          pathname: options?.pathname,
          predicate: options?.predicate,
          timeout,
        });
      });
    },
    async [Symbol.asyncDispose]() {
      for (const waiter of pendingWaiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error("websocket fixture disposed while waiting"));
      }
      wsServer.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}

export async function mockttpFixture() {
  const server = getLocal();
  await server.start();

  return {
    proxyUrl: `http://host.docker.internal:${String(server.port)}`,
    hostProxyUrl: `http://127.0.0.1:${String(server.port)}`,
    server,
    async [Symbol.asyncDispose]() {
      await server.stop();
    },
  };
}

export async function waitForHttpOk(url: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`timed out waiting for healthy endpoint: ${url}`);
}

type NomadJob = {
  ID?: string;
  TaskGroups?: Array<{
    Tasks?: Array<{
      Env?: Record<string, string>;
    }>;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseNomadJob(payload: unknown): NomadJob {
  if (isRecord(payload) && isRecord(payload.Job)) {
    return payload.Job as NomadJob;
  }
  if (isRecord(payload)) {
    return payload as NomadJob;
  }
  throw new Error("nomad parse returned unexpected payload shape");
}

function applyTaskEnvOverrides(job: NomadJob, envOverrides?: Record<string, string>) {
  if (!envOverrides) return;
  for (const group of job.TaskGroups ?? []) {
    for (const task of group.Tasks ?? []) {
      task.Env = {
        ...(task.Env ?? {}),
        ...envOverrides,
      };
    }
  }
}

async function responseErrorDetails(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return `${response.status} ${response.statusText}${body ? `: ${body}` : ""}`;
}

export async function waitForNomadLeader(nomadBaseUrl: string, timeoutMs = 60_000): Promise<void> {
  await waitForHttpOk(`${nomadBaseUrl}/v1/status/leader`, timeoutMs);
}

export async function nomadRegisterJobFromHcl(params: {
  nomadBaseUrl: string;
  jobHcl: string;
  jobId?: string;
  taskEnvOverrides?: Record<string, string>;
}): Promise<{ jobId: string }> {
  const parseResponse = await fetch(`${params.nomadBaseUrl}/v1/jobs/parse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      JobHCL: params.jobHcl,
      Canonicalize: true,
    }),
  });
  if (!parseResponse.ok) {
    throw new Error(`nomad jobs/parse failed: ${await responseErrorDetails(parseResponse)}`);
  }

  const parsedPayload = (await parseResponse.json()) as unknown;
  const parsedJob = parseNomadJob(parsedPayload);
  applyTaskEnvOverrides(parsedJob, params.taskEnvOverrides);

  const registerResponse = await fetch(`${params.nomadBaseUrl}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ Job: parsedJob }),
  });
  if (!registerResponse.ok) {
    throw new Error(`nomad jobs register failed: ${await responseErrorDetails(registerResponse)}`);
  }

  const resolvedJobId = params.jobId || parsedJob.ID;
  if (!resolvedJobId) {
    throw new Error("nomad job register succeeded but job id is missing");
  }

  return { jobId: resolvedJobId };
}

export async function nomadRegisterJobFromFile(params: {
  nomadBaseUrl: string;
  jobFilePath: string | URL;
  jobId?: string;
  taskEnvOverrides?: Record<string, string>;
}): Promise<{ jobId: string }> {
  const jobHcl = await readFile(params.jobFilePath, "utf-8");
  return await nomadRegisterJobFromHcl({
    nomadBaseUrl: params.nomadBaseUrl,
    jobHcl,
    jobId: params.jobId,
    taskEnvOverrides: params.taskEnvOverrides,
  });
}

export async function waitForNomadJobRunning(params: {
  nomadBaseUrl: string;
  jobId: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 90_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${params.nomadBaseUrl}/v1/job/${params.jobId}/summary`);
      if (response.ok) {
        const payload = (await response.json()) as {
          Summary?: Record<
            string,
            {
              Running?: number;
            }
          >;
        };
        const groups = Object.values(payload.Summary ?? {});
        if (groups.some((group) => (group.Running ?? 0) > 0)) {
          return;
        }
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`timed out waiting for nomad job to be running: ${params.jobId}`);
}

export async function nomadRegisterJobFromFileAndWait(params: {
  nomadBaseUrl: string;
  jobFilePath: string | URL;
  jobId?: string;
  taskEnvOverrides?: Record<string, string>;
  timeoutMs?: number;
}): Promise<{ jobId: string }> {
  const registered = await nomadRegisterJobFromFile({
    nomadBaseUrl: params.nomadBaseUrl,
    jobFilePath: params.jobFilePath,
    jobId: params.jobId,
    taskEnvOverrides: params.taskEnvOverrides,
  });
  await waitForNomadJobRunning({
    nomadBaseUrl: params.nomadBaseUrl,
    jobId: registered.jobId,
    timeoutMs: params.timeoutMs,
  });
  return registered;
}
