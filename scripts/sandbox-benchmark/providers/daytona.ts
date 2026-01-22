/**
 * Daytona provider implementation for benchmarking
 */

import { Daytona, Image } from "@daytonaio/sdk";
import type { ImageRef } from "../config.ts";
import type { CreateSandboxOptions, SandboxHandle, SandboxProvider } from "./types.ts";

const _BENCHMARK_SERVER_PORT = 8080;

export class DaytonaProvider implements SandboxProvider {
  readonly name = "daytona" as const;
  private daytona: Daytona;

  constructor() {
    const apiKey = process.env.DAYTONA_API_KEY;
    if (!apiKey) {
      throw new Error("DAYTONA_API_KEY environment variable required");
    }
    this.daytona = new Daytona({ apiKey });
  }

  async buildImage(dockerfilePath: string, imageName: string): Promise<ImageRef> {
    const image = Image.fromDockerfile(dockerfilePath);

    // Create snapshot with minimal resources for benchmarking
    const snapshotName = `benchmark-${imageName}-${Date.now()}`;

    console.log(`[daytona] Building snapshot: ${snapshotName}`);

    const snapshot = await this.daytona.snapshot.create(
      {
        name: snapshotName,
        image,
        resources: { cpu: 1, memory: 1, disk: 5 },
      },
      { onLogs: (log) => console.log(`[daytona build] ${log}`) },
    );

    console.log(`[daytona] Snapshot created: ${snapshot.name}`);

    return {
      provider: "daytona",
      identifier: snapshot.name,
      dockerfile: dockerfilePath,
      builtAt: new Date().toISOString(),
    };
  }

  async createSandbox(options: CreateSandboxOptions): Promise<SandboxHandle> {
    const name = options.name ?? `benchmark-${Date.now()}`;

    console.log(`[daytona] Creating sandbox: ${name}`);

    // Note: Resources can't be overridden when using a snapshot
    // They are determined at snapshot creation time
    const sandbox = await this.daytona.create({
      name,
      snapshot: options.image.identifier,
      envVars: options.envVars,
      autoStopInterval: 60, // Auto-stop after 1 hour idle
      autoDeleteInterval: 120, // Auto-delete after 2 hours
      public: true,
      networkBlockAll: false, // Allow outbound HTTP requests for callbacks
    });

    console.log(`[daytona] Sandbox created: ${sandbox.id}`);

    // Start the sandbox and wait for it to be running
    console.log(`[daytona] Starting sandbox: ${sandbox.id}`);
    await sandbox.start(300); // Wait up to 300 seconds for sandbox to start
    console.log(`[daytona] Sandbox started: ${sandbox.id}`);

    return {
      provider: "daytona",
      id: sandbox.id,
      name,
    };
  }

  async startSandbox(handle: SandboxHandle): Promise<void> {
    console.log(`[daytona] Starting sandbox: ${handle.id}`);
    const sandbox = await this.daytona.get(handle.id);
    await sandbox.start();
    console.log(`[daytona] Sandbox started: ${handle.id}`);
  }

  async stopSandbox(handle: SandboxHandle): Promise<void> {
    console.log(`[daytona] Stopping sandbox: ${handle.id}`);
    const sandbox = await this.daytona.get(handle.id);
    if (sandbox.state === "started") {
      await sandbox.stop();
    }
    console.log(`[daytona] Sandbox stopped: ${handle.id}`);
  }

  async deleteSandbox(handle: SandboxHandle): Promise<void> {
    console.log(`[daytona] Deleting sandbox: ${handle.id}`);
    try {
      const sandbox = await this.daytona.get(handle.id);
      if (sandbox.state === "started") {
        await sandbox.stop();
      }
      await sandbox.delete();
      console.log(`[daytona] Sandbox deleted: ${handle.id}`);
    } catch (error) {
      console.warn(`[daytona] Error deleting sandbox ${handle.id}:`, error);
    }
  }

  async getPublicUrl(handle: SandboxHandle, port: number): Promise<string> {
    const sandbox = await this.daytona.get(handle.id);
    const preview = await sandbox.getPreviewLink(port);
    return typeof preview === "string" ? preview : preview.url;
  }

  async listSandboxes(): Promise<SandboxHandle[]> {
    // List sandboxes with benchmark label
    const result = await this.daytona.list();
    // Handle paginated result - access sandboxes array
    const sandboxes: Array<{ id: string; name?: string }> =
      "sandboxes" in result && Array.isArray(result.sandboxes) ? result.sandboxes : [];
    return sandboxes
      .filter((s) => s.name?.startsWith("benchmark-"))
      .map((s) => ({
        provider: "daytona" as const,
        id: s.id,
        name: s.name ?? s.id,
      }));
  }

  // Wait for sandbox to be in a specific state
  async waitForState(
    handle: SandboxHandle,
    targetState: "started" | "stopped",
    timeoutMs = 60000,
  ): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const sandbox = await this.daytona.get(handle.id);
      if (sandbox.state === targetState) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timeout waiting for sandbox ${handle.id} to reach state ${targetState}`);
  }
}
