import { CaddyClient } from "@accelerated-software-development/caddy-api-client";
import {
  type EventBusContract,
  serviceManifest as eventsServiceManifest,
} from "@iterate-com/events-contract";
import { type RegistryClient } from "@iterate-com/registry-service/client";
import { type AnyContractRouter, type ContractRouterClient } from "@orpc/contract";
import pWaitFor from "p-wait-for";
import { type Client as PidnapClient } from "pidnap/client";
import {
  createOrpcRpcServiceClient,
  localHostForService,
  type ServiceManifestLike,
} from "../index.ts";
import { nodeHttpRequest } from "./deployment-utils.ts";

export type DeploymentCommandResult = {
  exitCode: number;
  output: string;
};

export interface DeploymentOpts {
  name?: string;
  env?: Record<string, string> | string[];
}

type EventBusClient = ContractRouterClient<EventBusContract>;

export interface DeploymentEventsClient {
  service: EventBusClient["service"];
  append: EventBusClient["append"];
  registerSubscription: EventBusClient["registerSubscription"];
  ackOffset: EventBusClient["ackOffset"];
  stream: EventBusClient["stream"];
  listStreams: EventBusClient["listStreams"];
  firehose: EventBusClient["firehose"];
}

type ProviderCreateResult<TLocator> = {
  locator: TLocator;
  baseUrl: string;
};

function makeFetchForHost(baseUrl: string, host: string): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestUrl = new URL(request.url);
    const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, baseUrl);
    const method = request.method.toUpperCase();
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-host", host);
    headers.delete("host");
    headers.delete("content-length");

    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : Buffer.from(await request.clone().arrayBuffer());
    if (body !== undefined) {
      headers.set("content-length", body.byteLength.toString());
    }

    return await nodeHttpRequest({ url: target, method, headers, body });
  };
}

export abstract class Deployment<
  TOpts extends DeploymentOpts = DeploymentOpts,
  TLocator = unknown,
> implements AsyncDisposable {
  protected state: "new" | "running" | "destroyed" = "new";
  protected locator: TLocator | null = null;

  public baseUrl = "";
  public pidnap!: PidnapClient;
  public caddy!: CaddyClient;
  public registry!: RegistryClient;
  public events!: DeploymentEventsClient;

  protected abstract providerCreate(opts: TOpts): Promise<ProviderCreateResult<TLocator>>;
  protected abstract providerDispose(): Promise<void>;
  protected abstract providerExec(cmd: string | string[]): Promise<DeploymentCommandResult>;
  protected abstract providerLogs(): Promise<string>;

  protected async initClients(): Promise<void> {
    const { createClient: createPidnapClient } = await import("pidnap/client");
    const { createRegistryClient } = await import("@iterate-com/registry-service/client");

    this.pidnap = createPidnapClient({
      url: `${this.baseUrl}/rpc`,
      fetch: makeFetchForHost(this.baseUrl, "pidnap.iterate.localhost"),
    });

    const caddy = new CaddyClient({ adminUrl: this.baseUrl });
    caddy.request = async (path: string, options: RequestInit = {}): Promise<Response> => {
      const url = new URL(path.startsWith("/") ? path : `/${path}`, this.baseUrl);
      const method = options.method ?? "GET";
      const headers = new Headers(options.headers);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      headers.set("x-forwarded-host", "caddy.iterate.localhost");
      headers.delete("host");
      const body =
        options.body == null
          ? undefined
          : Buffer.from(await new Response(options.body).arrayBuffer());
      if (body) headers.set("content-length", body.byteLength.toString());
      return await nodeHttpRequest({ url, method, headers, body, buffered: true });
    };
    this.caddy = caddy;

    this.registry = createRegistryClient({
      url: `${this.baseUrl}/orpc`,
      fetch: makeFetchForHost(this.baseUrl, "registry.iterate.localhost"),
    });

    this.events = createOrpcRpcServiceClient({
      env: {},
      manifest: eventsServiceManifest,
      url: `${this.baseUrl}/orpc`,
      fetch: makeFetchForHost(this.baseUrl, "events.iterate.localhost"),
    }) as DeploymentEventsClient;
  }

  async create(opts: TOpts): Promise<TLocator> {
    if (this.state !== "new") {
      throw new Error(`${this.constructor.name} is in state "${this.state}", expected "new"`);
    }

    console.log(`[deployment] creating ${this.constructor.name}...`);
    const result = await this.providerCreate(opts);
    this.baseUrl = result.baseUrl;
    this.locator = result.locator;
    await this.initClients();
    this.state = "running";
    console.log(`[deployment] created, baseUrl=${this.baseUrl}`);
    return result.locator;
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
    console.log(`[deployment] all core processes healthy`);
  }

  async fetch(host: string, path: string, init?: RequestInit): Promise<Response> {
    this.assertRunning();
    const url = new URL(path.startsWith("/") ? path : `/${path}`, this.baseUrl);
    const headers = new Headers(init?.headers);
    headers.set("x-forwarded-host", host);
    return await fetch(url, { ...init, headers });
  }

  createOrpcClient<TClient>(params: {
    host: string;
    path: "/rpc" | "/orpc";
    create: (options: { url: string; fetch: (request: Request) => Promise<Response> }) => TClient;
  }): TClient {
    return params.create({
      url: `http://${params.host}${params.path}`,
      fetch: makeFetchForHost(this.baseUrl, params.host),
    });
  }

  createServiceClient<TContract extends AnyContractRouter>(params: {
    manifest: ServiceManifestLike<TContract>;
    host?: string;
  }): ContractRouterClient<TContract> {
    const host = params.host ?? localHostForService({ slug: params.manifest.slug });
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

  async exec(cmd: string | string[]): Promise<DeploymentCommandResult> {
    this.assertRunning();
    return await this.providerExec(cmd);
  }

  async logs(): Promise<string> {
    return await this.providerLogs();
  }

  async destroy(): Promise<void> {
    if (this.state === "destroyed") return;
    console.log(`[deployment] destroying ${this.constructor.name}...`);
    if (this.state === "running") {
      await this.providerDispose();
    }
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
