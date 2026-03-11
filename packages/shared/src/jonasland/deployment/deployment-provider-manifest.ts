import type { ZodType } from "zod/v4";

/**
 * Provider opts configure one provider binding, such as API tokens or
 * alternate control-plane base URLs. They are not properties of a single
 * deployment runtime.
 */
export interface DeploymentProviderOpts {}

/**
 * Deployment opts describe one deployment runtime.
 *
 * Each provider must persist enough metadata on the provider runtime itself to
 * recover these effective options later from the runtime addressed by
 * `locator`.
 */
export interface DeploymentOpts {
  slug: string;
  /**
   * Convenience knob for whether the deployment rootfs should survive a normal
   * provider restart. Defaults to `true`.
   *
   * This is intentionally weaker than a mounted volume abstraction. Providers
   * may support this as a restart convenience without treating the rootfs as
   * durable storage.
   */
  rootfsSurvivesRestart?: boolean;
  /**
   * Environment variables for the main runtime.
   */
  env?: Record<string, string>;
  /**
   * Image or image reference to boot.
   */
  image?: string;
  /**
   * Process argv override for PID 1 entrypoint.
   */
  entrypoint?: string[];
  /**
   * Process argv override for PID 1 command.
   */
  cmd?: string[];
}

export interface DeploymentProviderStatus {
  state: DeploymentProviderState;
  detail: string;
}

export interface DeploymentExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * Combined stdout + stderr output kept for compatibility with older callers.
   */
  output: string;
}

export interface DeploymentProviderLogEvent {
  line: string;
  /**
   * Optional provider-specific structured log fields. Consumers should treat
   * this as best-effort metadata.
   */
  providerData?: Record<string, unknown>;
}

export interface DeploymentProviderManifest<
  TOpts extends DeploymentOpts = DeploymentOpts,
  TLocator = unknown,
  TProviderOpts extends DeploymentProviderOpts = DeploymentProviderOpts,
> {
  /**
   * Stable provider identifier such as "docker" or "fly".
   */
  readonly name: string;
  /**
   * Schema for provider binding config such as API tokens.
   */
  readonly providerOptsSchema: ZodType<TProviderOpts>;
  /**
   * Full schema for the effective deployment opts a created or reconnected
   * runtime should expose.
   */
  readonly optsSchema: ZodType<TOpts>;
  /**
   * Schema for the provider-specific locator used to reconnect to an existing
   * runtime.
   */
  readonly locatorSchema: ZodType<TLocator>;
  /**
   * Optional provider-specific escape hatches.
   */
  readonly capabilities?: Record<string, unknown>;
}

/**
 * Deployment provider runtime implementation.
 *
 * A provider has already had any provider-wide opts applied. It should stay
 * stateless and reusable after that construction step. These implementations
 * mostly mirror stateless backend APIs such as "create", "connect", "start",
 * "stop", and "destroy", so a plain object is enough.
 *
 * The most important reconnect contract here is `recoverOpts(...)`: callers
 * must be able to reconnect to an existing runtime using only a `locator`,
 * without replaying previously persisted deployment opts from some external
 * store.
 */
export interface DeploymentProvider<
  TOpts extends DeploymentOpts = DeploymentOpts,
  TLocator = unknown,
  TProviderOpts extends DeploymentProviderOpts = DeploymentProviderOpts,
> extends DeploymentProviderManifest<TOpts, TLocator, TProviderOpts> {
  create(params: { signal?: AbortSignal; opts: TOpts }): Promise<{
    locator: TLocator;
    baseUrl: string;
  }>;
  connect(params: { signal?: AbortSignal; locator: TLocator }): Promise<{
    locator: TLocator;
    baseUrl: string;
  }>;
  recoverOpts(params: { signal?: AbortSignal; locator: TLocator }): Promise<TOpts>;
  start(params: { signal?: AbortSignal; locator: TLocator }): Promise<void>;
  stop(params: { signal?: AbortSignal; locator: TLocator }): Promise<void>;
  destroy(params: { signal?: AbortSignal; locator: TLocator }): Promise<void>;
  exec(params: {
    signal?: AbortSignal;
    locator: TLocator;
    cmd: string[];
  }): Promise<DeploymentExecResult>;
  logs(params: {
    locator: TLocator;
    signal: AbortSignal;
    tail?: number;
  }): AsyncIterable<DeploymentProviderLogEvent>;
  status(params: { signal?: AbortSignal; locator: TLocator }): Promise<DeploymentProviderStatus>;
}

export type DeploymentProviderState =
  | "unknown"
  | "running"
  | "starting"
  | "stopped"
  | "destroyed"
  | "error";
