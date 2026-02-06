import { createTRPCClient, httpLink } from "@trpc/client";
import { createClient as createPidnapClient, type Client as PidnapClient } from "pidnap/client";
import type { z } from "zod/v4";

/**
 * Provider types supported by the sandbox system.
 */
export type ProviderType = "docker" | "daytona" | "fly";

/**
 * Machine types used by OS machine management.
 * Kept here as a shared source of truth for frontend/backend callers.
 */
export const MachineType = ["daytona", "docker", "local"] as const;
export type MachineType = (typeof MachineType)[number];

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
 * Each provider implements preview URL + lifecycle methods. The base class
 * provides shared fetch/client helpers.
 */
export abstract class Sandbox {
  abstract readonly providerId: string;
  abstract readonly type: ProviderType;
  private pidnapRpcBaseUrl?: string;

  // === Core abstraction ===

  /**
   * Get a fetch function configured for a specific port.
   * The returned fetch has the base URL and any required headers baked in.
   */
  async getFetch(opts: { port: number }): Promise<typeof fetch> {
    const baseUrl = await this.getPreviewUrl(opts);
    return (input: string | Request | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? `${baseUrl}${input}` : input;
      return fetch(url, init);
    };
  }

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
    const baseUrl = await this.resolvePidnapRpcBaseUrl();
    return createPidnapClient(baseUrl);
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

  /**
   * Reset memoized client endpoint state after lifecycle changes
   * (e.g. Docker restart can remap host ports).
   */
  protected resetClientCaches(): void {
    this.pidnapRpcBaseUrl = undefined;
  }

  /**
   * Detect pidnap RPC base path.
   *
   * Old snapshots use "/rpc/*" while newer builds serve at root ("/*").
   * We probe both for compatibility so tests can target mixed snapshots.
   */
  private async resolvePidnapRpcBaseUrl(): Promise<string> {
    if (this.pidnapRpcBaseUrl) return this.pidnapRpcBaseUrl;

    const previewUrl = await this.getPreviewUrl({ port: PIDNAP_PORT });
    const candidates = [`${previewUrl}/rpc`, previewUrl];

    for (const candidate of candidates) {
      try {
        const response = await fetch(`${candidate}/health`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          this.pidnapRpcBaseUrl = candidate;
          return candidate;
        }
      } catch {
        // Try next candidate
      }
    }

    throw new Error("pidnap RPC endpoint is not ready yet");
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
