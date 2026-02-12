import type { z } from "zod/v4";

export type SandboxFetcher = (
  input: string | Request | URL,
  init?: RequestInit,
) => Promise<Response>;

const SANDBOX_INGRESS_PORT = 8080;
const TARGET_HOST_HEADER = "x-iterate-proxy-target-host";

/**
 * Provider types supported by the sandbox system.
 */
export type ProviderType = "docker" | "daytona" | "fly";

/**
 * Machine types used by OS machine management.
 * Kept here as a shared source of truth for frontend/backend callers.
 */
export const MachineType = ["daytona", "docker", "fly", "local"] as const;
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
  /** Canonical, provider-agnostic external machine identifier. */
  externalId: string;
  /** Unique identifier for the sandbox (used for naming) */
  id?: string;
  /** Human-readable name for the sandbox */
  name: string;
  /** Environment variables to inject into the sandbox */
  envVars: Record<string, string>;
  /** Override the provider's default snapshot/image */
  providerSnapshotId?: string;
  /** Optional container entrypoint args (e.g. ["sleep", "infinity"]). */
  entrypointArguments?: string[];
}

/**
 * Abstract base class for sandbox instances.
 *
 * Each provider implements preview URL + lifecycle methods. The base class
 * provides a shared fetch helper.
 */
export abstract class Sandbox {
  abstract readonly providerId: string;
  abstract readonly type: ProviderType;

  // === Core abstraction ===

  /**
   * Get a fetcher for a specific port.
   * All traffic enters the sandbox through the ingress proxy on port 8080.
   * The requested target port is conveyed via X-Iterate-Proxy-Target-Host.
   */
  async getFetcher(opts: { port: number }): Promise<SandboxFetcher> {
    const ingressBaseUrl = await this.getBaseUrl({ port: SANDBOX_INGRESS_PORT });
    return (input: string | Request | URL, init?: RequestInit) => {
      const pathWithQuery = extractPathWithQuery(input);
      const targetUrl = new URL(pathWithQuery, ingressBaseUrl).toString();

      if (input instanceof Request) {
        // Preserve request upgrade semantics (WebSocket in particular) by
        // forwarding a Request object instead of rebuilding from URL + init.
        const upstreamRequest = new Request(targetUrl, input);
        const headers = new Headers(upstreamRequest.headers);
        if (init?.headers) {
          new Headers(init.headers).forEach((value, key) => {
            headers.set(key, value);
          });
        }
        if (!headers.has(TARGET_HOST_HEADER)) {
          headers.set(TARGET_HOST_HEADER, `localhost:${opts.port}`);
        }
        headers.forEach((value, key) => {
          upstreamRequest.headers.set(key, value);
        });
        return fetch(upstreamRequest);
      }

      const headers = new Headers();
      if (init?.headers) {
        new Headers(init.headers).forEach((value, key) => {
          headers.set(key, value);
        });
      }
      if (!headers.has(TARGET_HOST_HEADER)) {
        headers.set(TARGET_HOST_HEADER, `localhost:${opts.port}`);
      }

      const requestInit: RequestInit = {
        ...init,
        headers,
      };

      const requestInitWithDuplex = requestInit as RequestInit & { duplex?: "half" };
      const hasBody =
        requestInitWithDuplex.body !== undefined && requestInitWithDuplex.body !== null;
      if (hasBody && requestInitWithDuplex.duplex === undefined) {
        requestInitWithDuplex.duplex = "half";
      }

      return fetch(targetUrl, requestInitWithDuplex);
    };
  }

  /**
   * Get the base URL for a specific port.
   */
  abstract getBaseUrl(opts: { port: number }): Promise<string>;

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract restart(): Promise<void>;
  abstract delete(): Promise<void>;
  abstract exec(cmd: string[]): Promise<string>;
  abstract getState(): Promise<ProviderState>;
}

function extractPathWithQuery(input: string | Request | URL): string {
  if (input instanceof Request) {
    const url = new URL(input.url);
    return `${url.pathname}${url.search}`;
  }

  if (input instanceof URL) {
    return `${input.pathname}${input.search}`;
  }

  if (/^https?:\/\//.test(input)) {
    const url = new URL(input);
    return `${url.pathname}${url.search}`;
  }

  const normalized = input.startsWith("/") ? input : `/${input}`;
  return normalized;
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
