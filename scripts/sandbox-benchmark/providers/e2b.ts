/**
 * E2B provider implementation for benchmarking
 *
 * E2B uses Firecracker microVMs with ~150ms boot times from snapshots.
 * SDK: https://e2b.dev/docs
 *
 * Key characteristics:
 * - Templates are built via CLI: `e2b template build`
 * - Resources determined at template creation, not sandbox creation
 * - URL format: https://{sandboxId}-{port}.e2b.dev
 * - Sandboxes can be paused/resumed (no traditional start/stop)
 */

import { execSync } from "node:child_process";
import * as path from "node:path";
import { Sandbox } from "e2b";
import type { ImageRef } from "../config.ts";
import type { CreateSandboxOptions, SandboxHandle, SandboxProvider } from "./types.ts";

const _BENCHMARK_SERVER_PORT = 8080;

export class E2BProvider implements SandboxProvider {
  readonly name = "e2b" as const;

  constructor() {
    const apiKey = process.env.E2B_API_KEY;
    if (!apiKey) {
      throw new Error("E2B_API_KEY environment variable required");
    }
    // E2B SDK reads API key from E2B_API_KEY env var automatically
  }

  async buildImage(dockerfilePath: string, imageName: string): Promise<ImageRef> {
    // E2B requires templates to be built via CLI
    // The CLI reads the Dockerfile and creates a template
    const templateName = `benchmark-${imageName}-${Date.now()}`;
    const dockerfileDir = path.dirname(dockerfilePath);
    const dockerfileName = path.basename(dockerfilePath);

    console.log(`[e2b] Building template: ${templateName}`);
    console.log(`[e2b] Dockerfile: ${dockerfilePath}`);

    try {
      // Build template using E2B CLI
      // The CLI needs to be run from the directory containing the Dockerfile
      const cmd = `e2b template build --dockerfile ${dockerfileName} --name ${templateName} --cpu-count 1 --memory-mb 512`;

      console.log(`[e2b] Running: ${cmd}`);
      console.log(`[e2b] Working directory: ${dockerfileDir}`);

      const output = execSync(cmd, {
        cwd: dockerfileDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 600000, // 10 minute timeout for build
      });

      console.log(`[e2b] Build output: ${output}`);

      // Parse template ID from output
      // Output format typically includes the template ID
      const templateIdMatch = output.match(/Template ID:\s*(\S+)/i) || output.match(/(\S+)/);
      const templateId = templateIdMatch ? templateIdMatch[1] : templateName;

      console.log(`[e2b] Template created: ${templateId}`);

      return {
        provider: "e2b",
        identifier: templateName, // Use name as identifier since that's what we pass to create
        dockerfile: dockerfilePath,
        builtAt: new Date().toISOString(),
      };
    } catch (error) {
      console.error(`[e2b] Failed to build template:`, error);
      throw new Error(
        `E2B template build failed. Make sure e2b CLI is installed: npm install -g @e2b/cli`,
      );
    }
  }

  async createSandbox(options: CreateSandboxOptions): Promise<SandboxHandle> {
    const name = options.name ?? `benchmark-${Date.now()}`;

    console.log(`[e2b] Creating sandbox: ${name}`);
    console.log(`[e2b] Template: ${options.image.identifier}`);

    // Create sandbox from template
    const sandbox = await Sandbox.create(options.image.identifier, {
      timeoutMs: 300_000, // 5 minute timeout
      envs: options.envVars,
      metadata: {
        benchmark: "true",
        name,
      },
    });

    console.log(`[e2b] Sandbox created: ${sandbox.sandboxId}`);

    return {
      provider: "e2b",
      id: sandbox.sandboxId,
      name,
    };
  }

  async startSandbox(handle: SandboxHandle): Promise<void> {
    // E2B sandboxes use pause/resume instead of stop/start
    // Connecting to a paused sandbox automatically resumes it
    console.log(`[e2b] Resuming sandbox: ${handle.id}`);

    try {
      // Connect to the sandbox (will resume if paused)
      const _sandbox = await Sandbox.connect(handle.id);
      console.log(`[e2b] Sandbox resumed: ${handle.id}`);

      // Keep a reference or let it go - the sandbox stays running
      // We don't need to keep the connection open
    } catch (error) {
      console.error(`[e2b] Failed to resume sandbox:`, error);
      throw error;
    }
  }

  async stopSandbox(handle: SandboxHandle): Promise<void> {
    // E2B uses pause instead of stop
    console.log(`[e2b] Pausing sandbox: ${handle.id}`);

    try {
      const sandbox = await Sandbox.connect(handle.id);
      // @ts-expect-error - betaPause is available in newer SDK versions
      if (typeof sandbox.pause === "function") {
        // @ts-expect-error - pause method
        await sandbox.pause();
      } else {
        // Fallback: kill the sandbox (less ideal for restart benchmarks)
        console.warn(`[e2b] Pause not available, killing sandbox instead`);
        await sandbox.kill();
      }
      console.log(`[e2b] Sandbox paused: ${handle.id}`);
    } catch (error) {
      console.error(`[e2b] Failed to pause sandbox:`, error);
      throw error;
    }
  }

  async deleteSandbox(handle: SandboxHandle): Promise<void> {
    console.log(`[e2b] Deleting sandbox: ${handle.id}`);

    try {
      const sandbox = await Sandbox.connect(handle.id);
      await sandbox.kill();
      console.log(`[e2b] Sandbox deleted: ${handle.id}`);
    } catch (error) {
      // Sandbox might already be killed
      console.warn(`[e2b] Error deleting sandbox ${handle.id}:`, error);
    }
  }

  async getPublicUrl(handle: SandboxHandle, port: number): Promise<string> {
    // E2B URL format: https://{sandboxId}-{port}.e2b.dev
    // Or use sandbox.getHost(port) which returns the hostname
    try {
      const sandbox = await Sandbox.connect(handle.id);
      const host = sandbox.getHost(port);
      return `https://${host}`;
    } catch {
      // Fallback to constructing URL manually
      return `https://${handle.id}-${port}.e2b.dev`;
    }
  }

  async listSandboxes(): Promise<SandboxHandle[]> {
    console.log(`[e2b] Listing sandboxes`);

    const handles: SandboxHandle[] = [];

    try {
      // List all sandboxes
      const sandboxes = await Sandbox.list();

      for (const info of sandboxes) {
        // Filter for benchmark sandboxes
        if (info.metadata?.benchmark === "true") {
          handles.push({
            provider: "e2b",
            id: info.sandboxId,
            name: (info.metadata?.name as string) ?? info.sandboxId,
          });
        }
      }
    } catch (error) {
      console.error(`[e2b] Error listing sandboxes:`, error);
    }

    console.log(`[e2b] Found ${handles.length} benchmark sandboxes`);
    return handles;
  }
}
