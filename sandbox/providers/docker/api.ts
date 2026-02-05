/**
 * Docker API helpers
 *
 * Low-level Docker API client with support for both Unix socket and TCP connections.
 * Used by the Docker provider for container lifecycle management and exec.
 */
// TODO: evaluate dockerode (or similar) and swap if it fits.

interface DockerHostConfig {
  socketPath?: string;
  url: string;
}

function parseDockerHost(): DockerHostConfig {
  const dockerHost = process.env.DOCKER_HOST ?? "tcp://127.0.0.1:2375";

  if (dockerHost.startsWith("unix://")) {
    return { socketPath: dockerHost.slice(7), url: "http://localhost" };
  }
  if (dockerHost.startsWith("tcp://")) {
    return { url: `http://${dockerHost.slice(6)}` };
  }
  return { url: dockerHost };
}

/** Get Docker API URL and socket path. */
export function getDockerHostConfig(): DockerHostConfig {
  return parseDockerHost();
}

// Lazy-loaded undici dispatcher for Unix socket support
let undiciDispatcher: unknown | undefined;

async function getUndiciDispatcher(socketPath: string): Promise<unknown> {
  if (!undiciDispatcher) {
    const { Agent } = await import("undici");
    undiciDispatcher = new Agent({ connect: { socketPath } });
  }
  return undiciDispatcher;
}

/**
 * Make a Docker API request.
 *
 * @param method - HTTP method (GET, POST, DELETE)
 * @param endpoint - API endpoint (e.g., /containers/json)
 * @param body - Optional request body
 * @returns Parsed JSON response
 */
export async function dockerApi<T>(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const config = parseDockerHost();
  const dockerHost = process.env.DOCKER_HOST ?? "tcp://127.0.0.1:2375";
  const url = `${config.url}${endpoint}`;

  if (config.socketPath) {
    const { request } = await import("undici");
    const dispatcher = await getUndiciDispatcher(config.socketPath);
    const response = await request(url, {
      method: method as "GET" | "POST" | "DELETE",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      dispatcher: dispatcher as import("undici").Dispatcher,
    }).catch((e: unknown) => {
      throw new Error(
        `Docker API error: ${e}. DOCKER_HOST=${dockerHost}. ` +
          `For CI, set DOCKER_HOST=unix:///var/run/docker.sock`,
      );
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const error = await response.body.json().catch(() => ({ message: response.statusCode }));
      throw new Error(
        `Docker API error: ${(error as { message?: string }).message ?? response.statusCode}. ` +
          `DOCKER_HOST=${dockerHost}`,
      );
    }

    const text = await response.body.text();
    return text ? JSON.parse(text) : ({} as T);
  }

  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e: unknown) => {
    throw new Error(
      `Docker API error: ${e}. DOCKER_HOST=${dockerHost}. ` +
        `For local dev, enable TCP API on port 2375 (OrbStack: Docker Engine settings).`,
    );
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.status }));
    throw new Error(
      `Docker API error: ${(error as { message?: string }).message ?? response.status}. ` +
        `DOCKER_HOST=${dockerHost}`,
    );
  }

  const text = await response.text();
  return text ? JSON.parse(text) : ({} as T);
}

/**
 * Execute a command in a container and return stdout.
 *
 * @param containerId - Container ID or name
 * @param cmd - Command and arguments
 * @returns Command stdout
 */
export async function execInContainer(containerId: string, cmd: string[]): Promise<string> {
  // Create exec instance
  const execCreateResponse = await dockerApi<{ Id: string }>(
    "POST",
    `/containers/${containerId}/exec`,
    {
      AttachStdout: true,
      AttachStderr: true,
      Cmd: cmd,
    },
  );

  // Start exec and capture output
  const config = parseDockerHost();
  const url = `${config.url}/exec/${execCreateResponse.Id}/start`;

  if (config.socketPath) {
    const { request } = await import("undici");
    const dispatcher = await getUndiciDispatcher(config.socketPath);
    const response = await request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Detach: false }),
      dispatcher: dispatcher as import("undici").Dispatcher,
    });

    const buffer = await response.body.arrayBuffer();
    return stripDockerExecHeaders(new Uint8Array(buffer));
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Detach: false }),
  });

  const buffer = await response.arrayBuffer();
  return stripDockerExecHeaders(new Uint8Array(buffer));
}

/**
 * Strip Docker exec multiplexed stream headers from output.
 * Docker exec API uses a multiplexed protocol with 8-byte headers.
 */
function stripDockerExecHeaders(buffer: Uint8Array): string {
  const chunks: string[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;

    // Read header: [stream_type(1), 0, 0, 0, size(4)]
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset);
    const size = view.getUint32(4, false); // big-endian

    offset += 8; // Skip header

    if (offset + size > buffer.length) break;

    const chunk = buffer.slice(offset, offset + size);
    chunks.push(new TextDecoder().decode(chunk));
    offset += size;
  }

  return chunks.join("");
}

/**
 * Get container logs.
 *
 * @param containerId - Container ID or name
 * @param opts - Log options
 * @returns Container logs
 */
export async function getContainerLogs(
  containerId: string,
  opts: { stdout?: boolean; stderr?: boolean; tail?: number } = {},
): Promise<string> {
  const { stdout = true, stderr = true, tail = 100 } = opts;
  const params = new URLSearchParams({
    stdout: String(stdout),
    stderr: String(stderr),
    tail: String(tail),
  });

  const config = parseDockerHost();
  const url = `${config.url}/containers/${containerId}/logs?${params}`;

  if (config.socketPath) {
    const { request } = await import("undici");
    const dispatcher = await getUndiciDispatcher(config.socketPath);
    const response = await request(url, {
      method: "GET",
      dispatcher: dispatcher as import("undici").Dispatcher,
    });

    const buffer = await response.body.arrayBuffer();
    return stripDockerExecHeaders(new Uint8Array(buffer));
  }

  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  return stripDockerExecHeaders(new Uint8Array(buffer));
}

/**
 * Docker container inspect response types.
 */
export interface DockerInspect {
  Id?: string;
  State?: {
    Status?: string;
    Running?: boolean;
    Error?: string;
  };
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostPort?: string }> | null>;
  };
}

/**
 * Sanitize environment variables for Docker.
 * Validates names and removes control characters from values.
 */
export function sanitizeEnvVars(envVars: Record<string, string>): string[] {
  return Object.entries(envVars).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    // eslint-disable-next-line no-control-regex -- intentionally matching control chars to sanitize
    const sanitizedValue = String(value).replace(/[\u0000-\u001f]/g, "");
    return `${key}=${sanitizedValue}`;
  });
}

/**
 * Rewrite localhost URLs to host.docker.internal for container access.
 */
export function rewriteLocalhost(value: string): string {
  return value.replace(/localhost/g, "host.docker.internal");
}
