import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MachineProvider, CreateMachineConfig, MachineProviderResult } from "./types.ts";

export const DOCKER_API_URL = "http://127.0.0.1:2375";

// Repo root is ../../../../ from apps/os/backend/providers/
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

export async function dockerApi<T>(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${DOCKER_API_URL}${endpoint}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e: unknown) => {
    throw new Error(
      `Docker API error: ${e}. ` +
        `Make sure OrbStack/Docker is running with TCP API enabled on port 2375. Look for "Docker Engine" config in docs.`,
    );
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.status }));
    throw new Error(
      `Docker API error: ${(error as { message?: string }).message ?? response.status}. ` +
        `Make sure OrbStack/Docker is running with TCP API enabled on port 2375. Look for "Docker Engine" config in docs.`,
    );
  }

  const text = await response.text();
  return text ? JSON.parse(text) : ({} as T);
}

export interface LocalDockerConfig {
  imageName: string;
  findAvailablePort: () => Promise<number>;
}

export function createLocalVanillaProvider(): MachineProvider {
  return {
    type: "local-vanilla",
    async create(machineConfig: CreateMachineConfig): Promise<MachineProviderResult> {
      return { externalId: machineConfig.machineId };
    },
    async start(_externalId: string): Promise<void> {
      return;
    },
    async stop(_externalId: string): Promise<void> {
      return;
    },
    async restart(_externalId: string): Promise<void> {
      return;
    },
    async archive(_externalId: string): Promise<void> {
      return;
    },
    async delete(_externalId: string): Promise<void> {
      return;
    },
    getPreviewUrl(
      _externalId: string,
      _metadata?: Record<string, unknown>,
      _port?: number,
    ): string {
      return `http://localhost:${3000}`;
    },
  };
}

export function createLocalDockerProvider(config: LocalDockerConfig): MachineProvider {
  const { imageName, findAvailablePort } = config;

  return {
    type: "local-docker",

    async create(machineConfig: CreateMachineConfig): Promise<MachineProviderResult> {
      const port = await findAvailablePort();

      // Add ITERATE_DEV=true for local-docker so entry.ts uses the right code path
      const envVarsWithDev = {
        ...machineConfig.envVars,
        ITERATE_DEV: "true",
      };

      // Sanitize env vars to prevent injection attacks
      const envArray = Object.entries(envVarsWithDev).map(([key, value]) => {
        // Validate key contains only safe characters
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new Error(`Invalid environment variable name: ${key}`);
        }
        // Remove control characters (ASCII 0-31) from values to prevent injection
        // eslint-disable-next-line no-control-regex -- intentionally matching control chars to sanitize
        const sanitizedValue = String(value).replace(/[\u0000-\u001f]/g, "");
        return `${key}=${sanitizedValue}`;
      });

      // Mount local repo for development (allows code changes without rebuilding image)
      const binds = [`${REPO_ROOT}:/local-iterate-repo:ro`];

      const hostConfig: Record<string, unknown> = {
        PortBindings: {
          "3000/tcp": [{ HostPort: String(port) }],
        },
        Binds: binds,
      };

      const createResponse = await dockerApi<{ Id: string }>(
        "POST",
        `/containers/create?name=${encodeURIComponent(machineConfig.machineId)}`,
        {
          Image: imageName,
          Env: envArray,
          ExposedPorts: { "3000/tcp": {} },
          HostConfig: hostConfig,
        },
      );

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

    async restart(externalId: string): Promise<void> {
      await dockerApi("POST", `/containers/${externalId}/restart`, {});
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
