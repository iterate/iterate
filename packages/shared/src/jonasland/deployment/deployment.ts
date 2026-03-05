import {
  type EventBusContract,
  serviceManifest as eventsServiceManifest,
} from "@iterate-com/events-contract";
import { createRegistryClient, type RegistryClient } from "@iterate-com/registry/client";
import { type AnyContractRouter, type ContractRouterClient } from "@orpc/contract";
import pWaitFor from "p-wait-for";
import { createClient as createPidnapClient, type Client as PidnapClient } from "pidnap/client";
import {
  createOrpcOpenApiServiceClient,
  localHostForService,
  type ServiceManifestLike,
} from "../index.ts";
import { createCaddyAdminClient, createHostRoutedFetch } from "./deployment-utils.ts";

export type DeploymentCommandResult = {
  exitCode: number;
  output: string;
};

export type DeploymentFactory<TDeployment, TOpts> = (
  overrides?: Partial<TOpts>,
) => Promise<TDeployment>;

export type DeploymentProviderState =
  | "unknown"
  | "running"
  | "starting"
  | "stopped"
  | "destroyed"
  | "error";

export interface DeploymentProviderStatus {
  state: DeploymentProviderState;
  detail: string;
}

export interface ProvisionResult<TLocator> {
  locator: TLocator;
  baseUrl: string;
}

export interface DeploymentProvider<TOpts extends DeploymentOpts, TLocator> {
  create(opts: TOpts): Promise<ProvisionResult<TLocator>>;
  destroy(params: { locator: TLocator; opts: TOpts }): Promise<void>;
  exec(params: {
    locator: TLocator;
    opts: TOpts;
    cmd: string | string[];
  }): Promise<DeploymentCommandResult>;
  logs(params: { locator: TLocator; opts: TOpts }): Promise<string>;
  status(params: { locator: TLocator; opts: TOpts }): Promise<DeploymentProviderStatus>;
}

export const PIDNAP_LOG_TAIL_CMD =
  'for f in /var/log/pidnap/*.log; do echo "===== $f ====="; tail -n 200 "$f"; done 2>/dev/null || true';

export interface DeploymentOpts {
  name?: string;
  env?: Record<string, string> | string[];
  signal?: AbortSignal;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(`Operation aborted${signal.reason ? `: ${String(signal.reason)}` : ""}`);
}

function assertValidEnvVarKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable key: ${key}`);
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Base deployment lifecycle/state-machine around a stateless provider.
 *
 * Provider implementations (Docker/Fly/etc.) expose low-level operations
 * against a locator, while this class owns lifecycle guards, shared clients,
 * and helper flows used by callers/tests.
 */
export class Deployment<
  TOpts extends DeploymentOpts = DeploymentOpts,
  TLocator = unknown,
> implements AsyncDisposable {
  /**
   * Creates a factory that merges default create options with per-call overrides.
   *
   * Especially useful in tests, where a suite wants fixed provider config
   * (for example docker image or fly auth/token settings) but still overrides
   * per-test values like `name` and `signal`.
   */
  static makeFactory<TDeployment, TOpts>(
    this: { create(opts: TOpts): Promise<TDeployment> },
    defaults: TOpts,
  ): DeploymentFactory<TDeployment, TOpts> {
    return async (overrides = {}) =>
      await this.create({
        ...defaults,
        ...overrides,
      } as TOpts);
  }

  private state: "new" | "running" | "destroyed" = "new";
  private _locator: TLocator | null = null;
  private _opts: TOpts | null = null;

  public baseUrl = "";
  private _pidnapService: PidnapClient | null = null;
  private _caddyApi: ReturnType<typeof createCaddyAdminClient> | null = null;
  private _registryService: RegistryClient | null = null;
  private _eventsService: ContractRouterClient<EventBusContract> | null = null;
  private readonly provider: DeploymentProvider<TOpts, TLocator>;

  constructor(provider: DeploymentProvider<TOpts, TLocator>) {
    this.provider = provider;
  }

  async create(opts: TOpts): Promise<TLocator> {
    if (this.state !== "new") {
      throw new Error(`${this.constructor.name} is in state "${this.state}", expected "new"`);
    }
    console.log(`[deployment] creating ${this.constructor.name}...`);
    throwIfAborted(opts.signal);
    const provisioned = await this.provider.create(opts);
    this.baseUrl = provisioned.baseUrl;
    this._locator = provisioned.locator;
    this._opts = opts;
    this.state = "running";
    console.log(`[deployment] created, baseUrl=${this.baseUrl}`);
    return provisioned.locator;
  }

  private routedFetch(host: string): (request: Request) => Promise<Response> {
    return createHostRoutedFetch({ baseUrl: this.baseUrl, host });
  }

  get pidnapService(): PidnapClient {
    this.assertRunning();
    if (this._pidnapService) return this._pidnapService;
    this._pidnapService = createPidnapClient({
      url: `${this.baseUrl}/rpc`,
      fetch: this.routedFetch("pidnap.iterate.localhost"),
    });
    return this._pidnapService;
  }

  get caddyApi(): ReturnType<typeof createCaddyAdminClient> {
    this.assertRunning();
    if (this._caddyApi) return this._caddyApi;
    this._caddyApi = createCaddyAdminClient({
      baseUrl: this.baseUrl,
      host: "caddy.iterate.localhost",
    });
    return this._caddyApi;
  }

  get registryService(): RegistryClient {
    this.assertRunning();
    if (this._registryService) return this._registryService;
    this._registryService = createRegistryClient({
      url: `${this.baseUrl}/api`,
      fetch: this.routedFetch("registry.iterate.localhost"),
    });
    return this._registryService;
  }

  get eventsService(): ContractRouterClient<EventBusContract> {
    this.assertRunning();
    if (this._eventsService) return this._eventsService;
    this._eventsService = createOrpcOpenApiServiceClient({
      env: {},
      manifest: eventsServiceManifest,
      url: `${this.baseUrl}/api`,
      fetch: this.routedFetch("events.iterate.localhost"),
    });
    return this._eventsService;
  }

  get pidnap(): PidnapClient {
    return this.pidnapService;
  }

  get caddy(): ReturnType<typeof createCaddyAdminClient> {
    return this.caddyApi;
  }

  get registry(): RegistryClient {
    return this.registryService;
  }

  get events(): ContractRouterClient<EventBusContract> {
    return this.eventsService;
  }

  async waitUntilAlive(params?: { signal?: AbortSignal }): Promise<void> {
    this.assertRunning();
    const signal = params?.signal;
    const startedAt = Date.now();

    console.log(`[deployment] waiting for caddy at ${this.baseUrl}/__iterate/caddy-health...`);
    await pWaitFor(
      async () => {
        const resp = await fetch(`${this.baseUrl}/__iterate/caddy-health`, { signal }).catch(
          () => null,
        );
        return resp?.ok ?? false;
      },
      { interval: 500, signal },
    );
    console.log(`[deployment] caddy alive, waiting for core processes + routes...`);

    await pWaitFor(
      async () => {
        try {
          const result = await this.pidnapService.processes.waitFor({
            processes: { caddy: "running", registry: "running", events: "running" },
            timeoutMs: 5_000,
          });
          return result.allMet;
        } catch {
          return false;
        }
      },
      { interval: 1_000, signal },
    );

    const routeChecks = [
      { host: "registry.iterate.localhost", path: "/api/__iterate/health" },
      { host: "events.iterate.localhost", path: "/api/__iterate/health" },
    ];
    for (const check of routeChecks) {
      await pWaitFor(
        async () => {
          const resp = await this.fetch(check.host, check.path).catch(() => null);
          return resp?.ok ?? false;
        },
        { interval: 1_000, signal },
      );
    }
    console.log(`[deployment] alive in ${String(Date.now() - startedAt)}ms`);
  }

  async fetch(host: string, path: string, init?: RequestInit): Promise<Response> {
    this.assertRunning();
    const req = new Request(new URL(path.startsWith("/") ? path : `/${path}`, this.baseUrl), init);
    return await this.routedFetch(host)(req);
  }

  createServiceClient<TContract extends AnyContractRouter>(params: {
    manifest: ServiceManifestLike<TContract>;
  }): ContractRouterClient<TContract> {
    const host = localHostForService({ slug: params.manifest.slug });
    return createOrpcOpenApiServiceClient({
      env: {},
      manifest: params.manifest,
      url: `${this.baseUrl}/api`,
      fetch: this.routedFetch(host),
    });
  }

  async exec(cmd: string | string[]): Promise<DeploymentCommandResult> {
    this.assertRunning();
    return await this.provider.exec({
      locator: this.locator,
      opts: this.opts,
      cmd,
    });
  }

  async setEnvVars(env: Record<string, string>): Promise<void> {
    this.assertRunning();
    const entries = Object.entries(env);
    if (entries.length === 0) return;

    for (const [key] of entries) {
      assertValidEnvVarKey(key);
    }

    const lines = entries.map(
      ([key, value]) => `echo ${shellSingleQuote(`${key}=${value}`)} >> ~/.iterate/.env`,
    );

    const result = await this.exec(["sh", "-ec", ["mkdir -p ~/.iterate", ...lines].join("\n")]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed writing env vars to ~/.iterate/.env: ${result.output}`);
    }
  }

  async logs(): Promise<string> {
    this.assertRunning();
    return await this.provider.logs({
      locator: this.locator,
      opts: this.opts,
    });
  }

  async status(): Promise<DeploymentProviderStatus> {
    this.assertRunning();
    return await this.provider.status({
      locator: this.locator,
      opts: this.opts,
    });
  }

  async destroy(): Promise<void> {
    if (this.state === "destroyed") return;
    console.log(`[deployment] destroying ${this.constructor.name}...`);
    if (this.state === "running") {
      await this.provider.destroy({
        locator: this.locator,
        opts: this.opts,
      });
    }
    this._pidnapService = null;
    this._caddyApi = null;
    this._registryService = null;
    this._eventsService = null;
    this._locator = null;
    this._opts = null;
    this.state = "destroyed";
    console.log(`[deployment] destroyed`);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.destroy();
  }

  protected assertRunning(): void {
    if (this.state !== "running") {
      throw new Error(`${this.constructor.name} is not running (state=${this.state})`);
    }
  }

  toJSON() {
    return {
      kind: this.constructor.name,
      state: this.state,
      baseUrl: this.baseUrl,
      locator: this._locator,
    };
  }

  protected get locator(): TLocator {
    if (!this._locator) {
      throw new Error(`${this.constructor.name} has no locator`);
    }
    return this._locator;
  }

  protected get opts(): TOpts {
    if (!this._opts) {
      throw new Error(`${this.constructor.name} has no opts`);
    }
    return this._opts;
  }
}
