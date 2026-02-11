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

export interface RewriteLocalhostOptions {
  /** Local OS dev server port to use when rewriting *.dev.iterate.com URLs. */
  devIteratePort?: number;
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
 * @param params.method - HTTP method (GET, POST, DELETE)
 * @param params.endpoint - API endpoint (e.g., /containers/json)
 * @param params.body - Optional request body
 * @returns Parsed JSON response
 */
export async function dockerApi<T>(params: {
  method: string;
  endpoint: string;
  body?: unknown;
}): Promise<T> {
  const { method, endpoint, body } = params;
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
    return parseDockerResponse<T>(text);
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
  return parseDockerResponse<T>(text);
}

/**
 * Parse Docker API response, handling both JSON and NDJSON (newline-delimited JSON).
 * Some endpoints like POST /images/create return streaming NDJSON progress updates.
 * For NDJSON, we parse the last line which typically contains the final status.
 */
function parseDockerResponse<T>(text: string): T {
  if (!text) return {} as T;

  // Try parsing as regular JSON first
  try {
    return JSON.parse(text);
  } catch {
    // If that fails, try parsing as NDJSON (and surface streamed errors).
    const lines = text.trim().split("\n").filter(Boolean);
    if (lines.length > 0) {
      const parsedLines: Array<{ error?: string; errorDetail?: { message?: string } }> = [];
      for (const line of lines) {
        try {
          parsedLines.push(JSON.parse(line));
        } catch {
          // ignore invalid line; if everything is invalid we'll return empty object below
        }
      }
      const errorLine = parsedLines.find((line) => line.error || line.errorDetail?.message);
      if (errorLine) {
        throw new Error(errorLine.errorDetail?.message ?? errorLine.error ?? "Docker stream error");
      }
      if (parsedLines.length === 0) {
        return {} as T;
      }
      return parsedLines[parsedLines.length - 1] as T;
    }
    return {} as T;
  }
}

/**
 * Execute a command in a container and return stdout.
 *
 * @param params.containerId - Container ID or name
 * @param params.cmd - Command and arguments
 * @returns Command stdout
 */
export async function execInContainer(params: {
  containerId: string;
  cmd: string[];
}): Promise<string> {
  const { containerId, cmd } = params;
  // Create exec instance
  const execCreateResponse = await dockerApi<{ Id: string }>({
    method: "POST",
    endpoint: `/containers/${containerId}/exec`,
    body: {
      AttachStdout: true,
      AttachStderr: true,
      Cmd: cmd,
    },
  });

  const execId = execCreateResponse.Id;

  // Start exec and capture output
  const config = parseDockerHost();
  const url = `${config.url}/exec/${execId}/start`;

  let output: string;

  if (config.socketPath) {
    const { request } = await import("undici");
    const dispatcher = await getUndiciDispatcher(config.socketPath);
    const response = await request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Detach: false }),
      dispatcher: dispatcher as import("undici").Dispatcher,
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `Docker exec start failed: status=${response.statusCode}, container=${containerId}, cmd=${cmd.join(" ")}`,
      );
    }

    const buffer = await response.body.arrayBuffer();
    output = stripDockerExecHeaders(new Uint8Array(buffer));
  } else {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Detach: false }),
    });

    if (!response.ok) {
      throw new Error(
        `Docker exec start failed: status=${response.status}, container=${containerId}, cmd=${cmd.join(" ")}`,
      );
    }

    const buffer = await response.arrayBuffer();
    output = stripDockerExecHeaders(new Uint8Array(buffer));
  }

  const execState = await dockerApi<{ ExitCode?: number | null }>({
    method: "GET",
    endpoint: `/exec/${execId}/json`,
  });

  if (execState.ExitCode != null && execState.ExitCode !== 0) {
    const formattedOutput = output.trim();
    throw new Error(
      [
        `Docker exec failed: exit=${execState.ExitCode}, container=${containerId}, cmd=${cmd.join(" ")}`,
        formattedOutput.length > 0 ? `output=${formattedOutput}` : undefined,
      ]
        .filter((value): value is string => value != null)
        .join(", "),
    );
  }

  return output;
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
 * Rewrite local-development hostnames so containers resolve them via the Docker host gateway.
 * `*.dev.iterate.com` is dev-only; use direct host-gateway path for lower latency and fewer tunnel hops.
 */
export function rewriteLocalhost(value: string, options: RewriteLocalhostOptions = {}): string {
  const devIteratePort =
    Number.isInteger(options.devIteratePort) && (options.devIteratePort ?? 0) > 0
      ? options.devIteratePort
      : 5173;
  return value
    .replace(/localhost/g, "host.docker.internal")
    .replace(
      /https?:\/\/(?:[a-z0-9-]+\.)+dev\.iterate\.com(?::(\d+))?/gi,
      (_match, explicitPort) =>
        `http://host.docker.internal:${explicitPort ?? String(devIteratePort)}`,
    );
}
