import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent, request, type Dispatcher } from "undici";

interface DockerHostConfig {
  socketPath?: string;
  url: string;
}

function parseDockerHost(): DockerHostConfig {
  const dockerHost = (() => {
    if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;

    const dockerSocket = "/var/run/docker.sock";
    if (existsSync(dockerSocket)) {
      return `unix://${dockerSocket}`;
    }

    const orbstackSocket = join(homedir(), ".orbstack/run/docker.sock");
    if (existsSync(orbstackSocket)) {
      return `unix://${orbstackSocket}`;
    }

    return "tcp://127.0.0.1:2375";
  })();

  if (dockerHost.startsWith("unix://")) {
    return { socketPath: dockerHost.slice(7), url: "http://localhost" };
  }

  if (dockerHost.startsWith("tcp://")) {
    return { url: `http://${dockerHost.slice(6)}` };
  }

  return { url: dockerHost };
}

const dockerConfig = parseDockerHost();
const dispatcher: Dispatcher | undefined = dockerConfig.socketPath
  ? new Agent({ connect: { socketPath: dockerConfig.socketPath } })
  : undefined;

export async function dockerApi<T>(params: {
  method: string;
  endpoint: string;
  body?: unknown;
}): Promise<T> {
  const url = `${dockerConfig.url}${params.endpoint}`;
  const response = await request(url, {
    method: params.method as "GET" | "POST" | "DELETE",
    headers: params.body ? { "content-type": "application/json" } : undefined,
    body: params.body ? JSON.stringify(params.body) : undefined,
    dispatcher,
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const errorBody = await response.body.text();
    throw new Error(
      `Docker API error status=${response.statusCode} endpoint=${params.endpoint} body=${errorBody}`,
    );
  }

  const rawText = await response.body.text();
  if (!rawText) return {} as T;

  try {
    return JSON.parse(rawText) as T;
  } catch {
    return {} as T;
  }
}

export async function dockerApiRaw(params: {
  method: string;
  endpoint: string;
}): Promise<Uint8Array> {
  const response = await request(`${dockerConfig.url}${params.endpoint}`, {
    method: params.method as "GET" | "POST",
    dispatcher,
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Docker API raw error status=${response.statusCode} endpoint=${params.endpoint}`,
    );
  }

  return new Uint8Array(await response.body.arrayBuffer());
}

export interface DockerInspect {
  Id?: string;
  State?: {
    Status?: string;
    Running?: boolean;
  };
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
  };
}

export function decodeDockerMultiplexedStream(buffer: Uint8Array): string {
  const chunks: string[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const size =
      (buffer[offset + 4]! << 24) |
      (buffer[offset + 5]! << 16) |
      (buffer[offset + 6]! << 8) |
      buffer[offset + 7]!;

    offset += 8;
    if (offset + size > buffer.length) break;

    chunks.push(new TextDecoder().decode(buffer.slice(offset, offset + size)));
    offset += size;
  }

  return chunks.join("");
}

export async function execInContainer(params: {
  containerId: string;
  cmd: string[];
}): Promise<string> {
  const execCreate = await dockerApi<{ Id: string }>({
    method: "POST",
    endpoint: `/containers/${params.containerId}/exec`,
    body: {
      AttachStdout: true,
      AttachStderr: true,
      Cmd: params.cmd,
    },
  });

  const execId = execCreate.Id;

  const response = await request(`${dockerConfig.url}/exec/${execId}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ Detach: false }),
    dispatcher,
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Docker exec start failed status=${response.statusCode}`);
  }

  const output = decodeDockerMultiplexedStream(new Uint8Array(await response.body.arrayBuffer()));
  const execState = await dockerApi<{ ExitCode?: number | null }>({
    method: "GET",
    endpoint: `/exec/${execId}/json`,
  });

  if (execState.ExitCode != null && execState.ExitCode !== 0) {
    throw new Error(
      `Docker exec failed exit=${execState.ExitCode} cmd=${params.cmd.join(" ")} output=${output}`,
    );
  }

  return output;
}
