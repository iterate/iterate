/**
 * Provider interface for sandbox benchmarking
 */

import type { ImageRef, ProviderConfig, ProviderName } from "../config.ts";

// Handle to a created sandbox
export interface SandboxHandle {
  provider: ProviderName;
  id: string; // Provider's sandbox ID
  name: string; // Human-readable name
}

// Options for creating a sandbox
export interface CreateSandboxOptions {
  image: ImageRef;
  envVars: Record<string, string>;
  resources?: {
    cpu?: number;
    memoryMb?: number;
  };
  region?: string;
  name?: string;
}

// Callback payload sent by sandbox on boot
export interface BootCallback {
  sandboxId: string;
  timestamps: {
    processStart: number; // Date.now() when process started
    serverListening: number; // Date.now() when HTTP server ready
  };
  system: {
    hostname: string;
    cpuCount: number;
    memoryTotal: number;
  };
}

// Provider interface
export interface SandboxProvider {
  readonly name: ProviderName;

  // Build an image from a Dockerfile
  buildImage(dockerfilePath: string, imageName: string): Promise<ImageRef>;

  // Create and start a sandbox
  createSandbox(options: CreateSandboxOptions): Promise<SandboxHandle>;

  // Start a stopped sandbox
  startSandbox(handle: SandboxHandle): Promise<void>;

  // Stop a running sandbox
  stopSandbox(handle: SandboxHandle): Promise<void>;

  // Delete a sandbox
  deleteSandbox(handle: SandboxHandle): Promise<void>;

  // Get public URL for a port
  getPublicUrl(handle: SandboxHandle, port: number): Promise<string>;

  // List all sandboxes (for cleanup)
  listSandboxes(): Promise<SandboxHandle[]>;
}

// Factory to get provider by name
export type ProviderFactory = (name: ProviderName) => SandboxProvider;

// Extract provider-specific config
export function getProviderFromConfig(config: ProviderConfig): ProviderName {
  return config.provider;
}
