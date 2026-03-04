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

export interface DeploymentOpts {
  name?: string;
  env?: Record<string, string> | string[];
}

export abstract class Deployment<
  TOpts extends DeploymentOpts = DeploymentOpts,
  TLocator = unknown,
> implements AsyncDisposable {
  protected state: "new" | "running" | "destroyed" = "new";
  protected locator: TLocator | null = null;

  public baseUrl = "";
  private pidnapClient: PidnapClient | null = null;
  private caddyClient: ReturnType<typeof createCaddyAdminClient> | null = null;
  private registryClient: RegistryClient | null = null;
  private eventsClient: ContractRouterClient<EventBusContract> | null = null;

  abstract create(opts: TOpts): Promise<TLocator>;
  protected abstract dispose(): Promise<void>;
  abstract exec(cmd: string | string[]): Promise<DeploymentCommandResult>;
  abstract logs(): Promise<string>;

  get pidnap(): PidnapClient {
    this.assertRunning();
    if (this.pidnapClient) return this.pidnapClient;
    this.pidnapClient = createPidnapClient({
      url: `${this.baseUrl}/rpc`,
      fetch: createHostRoutedFetch({ baseUrl: this.baseUrl, host: "pidnap.iterate.localhost" }),
    });
    return this.pidnapClient;
  }

  get caddy(): ReturnType<typeof createCaddyAdminClient> {
    this.assertRunning();
    if (this.caddyClient) return this.caddyClient;
    this.caddyClient = createCaddyAdminClient({
      baseUrl: this.baseUrl,
      host: "caddy.iterate.localhost",
    });
    return this.caddyClient;
  }

  get registry(): RegistryClient {
    this.assertRunning();
    if (this.registryClient) return this.registryClient;
    this.registryClient = createRegistryClient({
      url: `${this.baseUrl}/orpc`,
      fetch: createHostRoutedFetch({ baseUrl: this.baseUrl, host: "registry.iterate.localhost" }),
    });
    return this.registryClient;
  }

  get events(): ContractRouterClient<EventBusContract> {
    this.assertRunning();
    if (this.eventsClient) return this.eventsClient;
    this.eventsClient = createOrpcRpcServiceClient({
      env: {},
      manifest: eventsServiceManifest,
      url: `${this.baseUrl}/orpc`,
      fetch: createHostRoutedFetch({ baseUrl: this.baseUrl, host: "events.iterate.localhost" }),
    });
    return this.eventsClient;
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

    const result = await this.pidnap.processes.waitFor({
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

  getDeploymentLocator(): TLocator {
    if (this.locator == null) {
      throw new Error(`${this.constructor.name} has no locator`);
    }
    return this.locator;
  }

  async destroy(): Promise<void> {
    if (this.state === "destroyed") return;
    console.log(`[deployment] destroying ${this.constructor.name}...`);
    if (this.state === "running") {
      await this.dispose();
    }
    this.pidnapClient = null;
    this.caddyClient = null;
    this.registryClient = null;
    this.eventsClient = null;
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
      locator: this.locator,
    };
  }
}
