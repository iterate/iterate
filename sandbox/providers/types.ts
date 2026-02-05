import { createTRPCClient, httpLink } from "@trpc/client";
import { createClient as createPidnapClient, type Client as PidnapClient } from "pidnap/client";
import type { z } from "zod/v4";

/**
 * Provider types supported by the sandbox system.
 */
export type ProviderType = "docker" | "daytona";

/**
 * Provider-level state info.
 */
export interface ProviderState {
  state: string;
  errorReason?: string;
}

/**
 * Info about a sandbox from listing.
 */
export interface SandboxInfo {
  type: ProviderType;
  providerId: string;
  name: string;
  state: string;
}

/**
 * Info about a snapshot/image from listing.
 */
export interface SnapshotInfo {
  type: ProviderType;
  snapshotId: string;
  name?: string;
  createdAt?: Date;
}

/**
 * Options for creating a new sandbox.
 */
export interface CreateSandboxOptions {
  /** Unique identifier for the sandbox (used for naming) */
  id?: string;
  /** Human-readable name for the sandbox */
  name: string;
  /** Environment variables to inject into the sandbox */
  envVars: Record<string, string>;
  /** Override the provider's defaultSnapshotId */
  snapshotId?: string;
  /**
   * Override the container command. Docker-only - Daytona ignores this.
   * When provided, entry.sh execs this command directly instead of starting pidnap.
   */
  command?: string[];
}

// Ports used by sandbox services
const DAEMON_PORT = 3000;
const PIDNAP_PORT = 9876;

/**
 * Abstract base class for sandbox instances.
 *
 * Each provider implements the abstract methods. The base class provides
 * shared implementations for clients built on top of getFetch().
 */
export abstract class Sandbox {
  abstract readonly providerId: string;
  abstract readonly type: ProviderType;

  // === Core abstraction (each provider implements) ===

  /**
   * Get a fetch function configured for a specific port.
   * The returned fetch has the base URL and any required headers baked in.
   */
  abstract getFetch(opts: { port: number }): Promise<typeof fetch>;

  /**
   * Get a preview URL for a specific port (for display/browser).
   */
  abstract getPreviewUrl(opts: { port: number }): Promise<string>;

  // === Lifecycle (each provider implements) ===

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract restart(): Promise<void>;
  abstract delete(): Promise<void>;
  abstract exec(cmd: string[]): Promise<string>;
  abstract getState(): Promise<ProviderState>;

  // === Clients (shared implementation using getFetch) ===

  /**
   * Get a pidnap oRPC client for process management.
   */
  async pidnapClient(): Promise<PidnapClient> {
    const baseUrl = await this.getPreviewUrl({ port: PIDNAP_PORT });
    return createPidnapClient(`${baseUrl}/rpc`);
  }

  /**
   * Get a tRPC client for the daemon backend.
   * Callers should cast to TRPCClient<TRPCRouter> for type safety.
   */
  async daemonClient(): Promise<ReturnType<typeof createTRPCClient>> {
    const baseUrl = await this.getPreviewUrl({ port: DAEMON_PORT });
    return createTRPCClient({
      links: [httpLink({ url: `${baseUrl}/api/trpc` })],
    });
  }
}

/**
 * Abstract base class for sandbox providers.
 *
 * Each provider defines its env schema and implements create/get/list methods.
 */
export abstract class SandboxProvider {
  /**
   * Zod schema for environment variables required by this provider.
   * Parsed in constructor, available as this.env.
   */
  protected abstract readonly envSchema: z.ZodType<Record<string, unknown>>;

  /**
   * Parsed, typed environment variables.
   */
  protected env!: Record<string, unknown>;

  abstract readonly type: ProviderType;

  /**
   * Default snapshot/image ID for creating sandboxes.
   * Typically reads from this.env.
   */
  abstract readonly defaultSnapshotId: string;

  /**
   * Subclasses must call parseEnv(rawEnv) in their constructor AFTER super().
   * This is because class field declarations (like envSchema) are initialized
   * after super() returns.
   */

  constructor(_rawEnv: Record<string, string | undefined>) {
    // Do NOT call parseEnv here - envSchema isn't initialized yet
  }

  protected parseEnv(rawEnv: Record<string, string | undefined>): void {
    this.env = this.envSchema.parse(rawEnv);
  }

  /**
   * Create a new sandbox.
   */
  abstract create(opts: CreateSandboxOptions): Promise<Sandbox>;

  /**
   * Get a handle to an existing sandbox by provider ID.
   * Returns a handle immediately; operations will fail if sandbox doesn't exist.
   */
  abstract get(providerId: string): Sandbox | null;

  /**
   * List all sandboxes managed by this provider.
   */
  abstract listSandboxes(): Promise<SandboxInfo[]>;

  /**
   * List available snapshots/images for this provider.
   */
  abstract listSnapshots(): Promise<SnapshotInfo[]>;
}
