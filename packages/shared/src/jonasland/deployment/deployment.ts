import {
  type EventBusContract,
  serviceManifest as eventsServiceManifest,
} from "@iterate-com/events-contract";
import { createRegistryClient, type RegistryClient } from "@iterate-com/registry-service/client";
import { type AnyContractRouter, type ContractRouterClient } from "@orpc/contract";
import pWaitFor from "p-wait-for";
import { createClient as createPidnapClient, type Client as PidnapClient } from "pidnap/client";
import {
  createOrpcRpcServiceClient,
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

  get pidnapService(): PidnapClient {
    this.assertRunning();
    if (this._pidnapService) return this._pidnapService;
    this._pidnapService = createPidnapClient({
      url: `${this.baseUrl}/rpc`,
      fetch: createHostRoutedFetch({ baseUrl: this.baseUrl, host: "pidnap.iterate.localhost" }),
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
      url: `${this.baseUrl}/orpc`,
      fetch: createHostRoutedFetch({ baseUrl: this.baseUrl, host: "registry.iterate.localhost" }),
    });
    return this._registryService;
  }

  get eventsService(): ContractRouterClient<EventBusContract> {
    this.assertRunning();
    if (this._eventsService) return this._eventsService;
    this._eventsService = createOrpcRpcServiceClient({
      env: {},
      manifest: eventsServiceManifest,
      url: `${this.baseUrl}/orpc`,
      fetch: createHostRoutedFetch({ baseUrl: this.baseUrl, host: "events.iterate.localhost" }),
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

    console.log(`[deployment] waiting for caddy at ${this.baseUrl}/healthz...`);
    await pWaitFor(
      async () => {
        const resp = await fetch(`${this.baseUrl}/healthz`, { signal }).catch(() => null);
        return resp?.ok ?? false;
      },
      { interval: 250, signal },
    );
    console.log(`[deployment] caddy alive, waiting for core processes...`);

    const result = await this.pidnapService.processes.waitFor({
      processes: { caddy: "healthy", registry: "healthy", events: "healthy" },
      timeoutMs: 120_000,
    });
    if (!result.allMet) {
      const summary = Object.entries(result.results)
        .map(([name, r]) => `${name}: state=${r.state} healthy=${String(r.healthy)}`)
        .join(", ");
      throw new Error(`[deployment] core processes not ready: ${summary}`);
    }
    console.log(`[deployment] all core processes healthy, verifying routes...`);

    const routeChecks = [
      { host: "registry.iterate.localhost", path: "/orpc/service/health" },
      { host: "events.iterate.localhost", path: "/api/service/health" },
    ];
    for (const check of routeChecks) {
      await pWaitFor(
        async () => {
          const resp = await this.fetch(check.host, check.path).catch(() => null);
          return resp?.ok ?? false;
        },
        { interval: 250, signal },
      );
    }
    console.log(`[deployment] all service routes verified`);
  }

  async fetch(host: string, path: string, init?: RequestInit): Promise<Response> {
    this.assertRunning();
    const url = new URL(path.startsWith("/") ? path : `/${path}`, this.baseUrl);
    const headers = new Headers(init?.headers);
    headers.set("x-forwarded-host", host);
    return await fetch(url, { ...init, headers });
  }

  private createOrpcClient<TClient>(params: {
    host: string;
    path: "/rpc" | "/orpc";
    create: (options: { url: string; fetch: (request: Request) => Promise<Response> }) => TClient;
  }): TClient {
    return params.create({
      url: `http://${params.host}${params.path}`,
      fetch: createHostRoutedFetch({ baseUrl: this.baseUrl, host: params.host }),
    });
  }

  createServiceClient<TContract extends AnyContractRouter>(params: {
    manifest: ServiceManifestLike<TContract>;
  }): ContractRouterClient<TContract> {
    const host = localHostForService({ slug: params.manifest.slug });
    return this.createOrpcClient({
      host,
      path: "/orpc",
      create: ({ url, fetch }) =>
        createOrpcRpcServiceClient({ env: {}, manifest: params.manifest, url, fetch }),
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
