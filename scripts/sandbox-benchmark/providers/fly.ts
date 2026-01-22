/**
 * Fly.io provider implementation for benchmarking
 *
 * Fly.io uses Firecracker microVMs with ~300ms boot times.
 * No SDK - uses REST API directly: https://api.machines.dev
 *
 * Key characteristics:
 * - Must create "app" first, then create machines within it
 * - Image building via `fly deploy` or push to registry
 * - URL format: {app-name}.fly.dev (requires services config)
 * - Per-second billing while running
 */

import type { ImageRef } from "../config.ts";
import type { CreateSandboxOptions, SandboxHandle, SandboxProvider } from "./types.ts";

const FLY_API_HOSTNAME = "https://api.machines.dev";
const BENCHMARK_SERVER_PORT = 8080;

// Fly API response types
interface FlyApp {
  id: string;
  name: string;
  organization: { slug: string };
  status: string;
}

interface FlyMachine {
  id: string;
  name: string;
  state: string;
  region: string;
  instance_id: string;
  private_ip: string;
  created_at: string;
  config: Record<string, unknown>;
}

// Extended handle that includes app name (needed for API calls)
interface FlyHandle extends SandboxHandle {
  appName: string;
  machineId: string;
}

export class FlyProvider implements SandboxProvider {
  readonly name = "fly" as const;
  private apiToken: string;
  private orgSlug: string;

  constructor() {
    // Support both FLY_API_TOKEN and FLY_API_KEY
    const apiToken = process.env.FLY_API_TOKEN ?? process.env.FLY_API_KEY;
    if (!apiToken) {
      throw new Error("FLY_API_TOKEN or FLY_API_KEY environment variable required");
    }
    this.apiToken = apiToken;
    // Default to 'iterate' org (our Fly org), can be overridden via env
    this.orgSlug = process.env.FLY_ORG_SLUG ?? "iterate";
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${FLY_API_HOSTNAME}${path}`;
    const options: RequestInit = {
      method,
      headers: this.headers,
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Fly API error: ${response.status} ${response.statusText} - ${text}`);
    }

    // Some endpoints return empty responses
    const text = await response.text();
    if (!text) return {} as T;

    return JSON.parse(text) as T;
  }

  async buildImage(dockerfilePath: string, imageName: string): Promise<ImageRef> {
    // Fly.io image building options:
    // 1. Use `fly deploy` CLI (requires fly.toml)
    // 2. Build locally and push to registry.fly.io
    // 3. Use existing public Docker images
    //
    // For benchmarking, we'll support using pre-built public images
    // The identifier will be the full image path (e.g., registry-1.docker.io/library/node:22)

    console.log(`[fly] Building image is not directly supported`);
    console.log(`[fly] Use a pre-built image or push to registry.fly.io manually`);
    console.log(`[fly] Dockerfile: ${dockerfilePath}`);

    // For now, we'll create a reference that expects the image to already exist
    // Users should build and push their image before running benchmarks
    const identifier = `registry.fly.io/benchmark-${imageName}:latest`;

    console.log(`[fly] Expected image location: ${identifier}`);
    console.log(
      `[fly] To build and push: fly deploy --dockerfile ${dockerfilePath} --image-label latest`,
    );

    return {
      provider: "fly",
      identifier,
      dockerfile: dockerfilePath,
      builtAt: new Date().toISOString(),
    };
  }

  async createSandbox(options: CreateSandboxOptions): Promise<SandboxHandle> {
    const appName = options.name ?? `benchmark-${Date.now()}`;

    console.log(`[fly] Creating app: ${appName}`);

    // Step 1: Create the app
    try {
      await this.request<FlyApp>("POST", "/v1/apps", {
        app_name: appName,
        org_slug: this.orgSlug,
      });
      console.log(`[fly] App created: ${appName}`);
    } catch (error) {
      // App might already exist
      console.warn(`[fly] App creation warning:`, error);
    }

    // Step 2: Create machine within the app
    console.log(`[fly] Creating machine in app: ${appName}`);

    const machineConfig = {
      config: {
        image: options.image.identifier,
        auto_destroy: false, // We'll manage lifecycle ourselves
        env: options.envVars,
        guest: {
          cpu_kind: "shared",
          cpus: options.resources?.cpu ?? 1,
          memory_mb: options.resources?.memoryMb ?? 512,
        },
        services: [
          {
            protocol: "tcp",
            internal_port: BENCHMARK_SERVER_PORT,
            ports: [
              {
                port: 80,
                handlers: ["http"],
                force_https: true,
              },
              {
                port: 443,
                handlers: ["http", "tls"],
              },
            ],
          },
        ],
      },
      region: options.region ?? "ord",
    };

    const machine = await this.request<FlyMachine>(
      "POST",
      `/v1/apps/${appName}/machines`,
      machineConfig,
    );

    console.log(`[fly] Machine created: ${machine.id} in region ${machine.region}`);

    // Step 3: Wait for machine to start
    console.log(`[fly] Waiting for machine to start...`);
    await this.waitForMachineState(appName, machine.id, "started");
    console.log(`[fly] Machine started: ${machine.id}`);

    // Return handle with both app name and machine ID encoded
    // We encode both in the id field as JSON so we can reconstruct later
    const handleData: FlyHandle = {
      provider: "fly",
      id: JSON.stringify({ appName, machineId: machine.id }),
      name: appName,
      appName,
      machineId: machine.id,
    };

    return handleData;
  }

  private parseHandle(handle: SandboxHandle): { appName: string; machineId: string } {
    try {
      // Try parsing as JSON (new format)
      const data = JSON.parse(handle.id);
      return { appName: data.appName, machineId: data.machineId };
    } catch {
      // Fallback: assume id is just the app name (legacy format)
      return { appName: handle.name, machineId: handle.id };
    }
  }

  async startSandbox(handle: SandboxHandle): Promise<void> {
    const { appName, machineId } = this.parseHandle(handle);
    console.log(`[fly] Starting machine: ${machineId} in app: ${appName}`);

    await this.request("POST", `/v1/apps/${appName}/machines/${machineId}/start`);

    // Wait for machine to be started
    await this.waitForMachineState(appName, machineId, "started");
    console.log(`[fly] Machine started: ${machineId}`);
  }

  async stopSandbox(handle: SandboxHandle): Promise<void> {
    const { appName, machineId } = this.parseHandle(handle);
    console.log(`[fly] Stopping machine: ${machineId} in app: ${appName}`);

    await this.request("POST", `/v1/apps/${appName}/machines/${machineId}/stop`, {
      signal: "SIGTERM",
      timeout: "30s",
    });

    // Wait for machine to be stopped
    await this.waitForMachineState(appName, machineId, "stopped");
    console.log(`[fly] Machine stopped: ${machineId}`);
  }

  async deleteSandbox(handle: SandboxHandle): Promise<void> {
    const { appName, machineId } = this.parseHandle(handle);
    console.log(`[fly] Deleting sandbox: ${appName}`);

    try {
      // First try to delete the machine
      await this.request("DELETE", `/v1/apps/${appName}/machines/${machineId}?force=true`);
      console.log(`[fly] Machine deleted: ${machineId}`);
    } catch (error) {
      console.warn(`[fly] Error deleting machine:`, error);
    }

    try {
      // Then delete the app itself
      await this.request("DELETE", `/v1/apps/${appName}`);
      console.log(`[fly] App deleted: ${appName}`);
    } catch (error) {
      console.warn(`[fly] Error deleting app:`, error);
    }
  }

  async getPublicUrl(handle: SandboxHandle, _port: number): Promise<string> {
    const { appName } = this.parseHandle(handle);
    // Fly.io public URL format (when services are configured)
    // Port mapping is handled by the services config, so we use the app URL
    return `https://${appName}.fly.dev`;
  }

  async listSandboxes(): Promise<SandboxHandle[]> {
    console.log(`[fly] Listing benchmark apps`);

    const handles: SandboxHandle[] = [];

    try {
      // List all apps in our org and filter for benchmark ones
      const response = await this.request<{ apps: FlyApp[] }>(
        "GET",
        `/v1/apps?org_slug=${this.orgSlug}`,
      );
      const apps = response.apps ?? [];

      for (const app of apps) {
        if (app.name.startsWith("benchmark-")) {
          // Get machines in this app
          try {
            const machines = await this.request<FlyMachine[]>(
              "GET",
              `/v1/apps/${app.name}/machines`,
            );

            for (const machine of machines) {
              handles.push({
                provider: "fly",
                id: JSON.stringify({ appName: app.name, machineId: machine.id }),
                name: app.name,
              });
            }

            // If no machines, still add the app for cleanup
            if (machines.length === 0) {
              handles.push({
                provider: "fly",
                id: JSON.stringify({ appName: app.name, machineId: "" }),
                name: app.name,
              });
            }
          } catch (error) {
            console.warn(`[fly] Error listing machines for ${app.name}:`, error);
          }
        }
      }
    } catch (error) {
      console.error(`[fly] Error listing apps:`, error);
    }

    console.log(`[fly] Found ${handles.length} benchmark sandboxes`);
    return handles;
  }

  // Wait for machine to reach a specific state
  private async waitForMachineState(
    appName: string,
    machineId: string,
    targetState: "started" | "stopped",
    timeoutMs = 120000,
  ): Promise<void> {
    const startTime = Date.now();

    // For "started" state, we can use the wait endpoint
    if (targetState === "started") {
      while (Date.now() - startTime < timeoutMs) {
        try {
          await this.request(
            "GET",
            `/v1/apps/${appName}/machines/${machineId}/wait?state=started&timeout=30`,
          );
          return;
        } catch {
          if (Date.now() - startTime >= timeoutMs) {
            throw new Error(`Timeout waiting for machine ${machineId} to reach state started`);
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }

    // For "stopped" state, poll because wait requires instance_id
    while (Date.now() - startTime < timeoutMs) {
      try {
        const machine = await this.request<FlyMachine>(
          "GET",
          `/v1/apps/${appName}/machines/${machineId}`,
        );
        if (machine.state === targetState) {
          return;
        }
      } catch {
        // Ignore errors and retry
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Timeout waiting for machine ${machineId} to reach state ${targetState}`);
  }
}
