import type { MachineProvider, CreateMachineConfig, MachineProviderResult } from "./types.ts";

export const DOCKER_API_URL = "http://127.0.0.1:2375";

export async function dockerApi<T>(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${DOCKER_API_URL}${endpoint}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(
      `Docker API error: ${(error as { message?: string }).message ?? response.statusText}. ` +
        `Make sure OrbStack/Docker is running with TCP API enabled on port 2375.`,
    );
  }

  const text = await response.text();
  return text ? JSON.parse(text) : ({} as T);
}

export interface LocalDockerConfig {
  imageName: string;
  findAvailablePort: () => Promise<number>;
}

export function createLocalDockerProvider(config: LocalDockerConfig): MachineProvider {
  const { imageName, findAvailablePort } = config;

  return {
    type: "local-docker",

    async create(machineConfig: CreateMachineConfig): Promise<MachineProviderResult> {
      const port = await findAvailablePort();

      // Sanitize env vars to prevent injection attacks
      const envArray = Object.entries(machineConfig.envVars).map(([key, value]) => {
        // Validate key contains only safe characters
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new Error(`Invalid environment variable name: ${key}`);
        }
        // Remove control characters (ASCII 0-31) from values to prevent injection
        // eslint-disable-next-line no-control-regex -- intentionally matching control chars to sanitize
        const sanitizedValue = String(value).replace(/[\u0000-\u001f]/g, "");
        return `${key}=${sanitizedValue}`;
      });

      const hostConfig: Record<string, unknown> = {
        PortBindings: {
          "3000/tcp": [{ HostPort: String(port) }],
        },
      };

      const createResponse = await dockerApi<{ Id: string }>("POST", "/containers/create", {
        Image: imageName,
        name: machineConfig.machineId,
        Env: envArray,
        ExposedPorts: { "3000/tcp": {} },
        HostConfig: hostConfig,
      });

      const containerId = createResponse.Id;

      await dockerApi("POST", `/containers/${containerId}/start`, {});

      return {
        externalId: containerId,
        metadata: { port, containerId },
      };
    },

    async start(externalId: string): Promise<void> {
      await dockerApi("POST", `/containers/${externalId}/start`, {});
    },

    async stop(externalId: string): Promise<void> {
      try {
        await dockerApi("POST", `/containers/${externalId}/stop`, {});
      } catch {
        // Container might already be stopped
      }
    },

    async archive(externalId: string): Promise<void> {
      await this.stop(externalId);
    },

    async delete(externalId: string): Promise<void> {
      await dockerApi("DELETE", `/containers/${externalId}?force=true`, undefined);
    },

    getPreviewUrl(_externalId: string, metadata?: Record<string, unknown>, port?: number): string {
      const basePort = (metadata as { port?: number })?.port ?? 3000;
      return `http://localhost:${port ?? basePort}`;
    },
  };
}
