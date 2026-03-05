import { CaddyClient } from "@accelerated-software-development/caddy-api-client";
import {
  type EventBusContract,
  serviceManifest as eventsServiceManifest,
} from "@iterate-com/events/contract";
import { type RegistryClient } from "@iterate-com/registry/client";
import { type AnyContractRouter, type ContractRouterClient } from "@orpc/contract";
import pRetry from "p-retry";
import pWaitFor from "p-wait-for";
import { type Client as PidnapClient } from "pidnap/client";
import {
  normalizePublicIngressUrlType,
  resolvePublicIngressUrl,
  type PublicIngressUrlType,
  type PublicIngressUrlTypeInput,
} from "../ingress-url.ts";
import {
  createOrpcRpcServiceClient,
  localHostForService,
  serviceManifestToPidnapConfig,
  type ServiceManifestLike,
  type ServiceManifestWithEntryPoint,
} from "../index.ts";
import { isRetriableNetworkError, nodeHttpRequest, shQuote } from "./deployment-utils.ts";
import {
  onDemandProcesses,
  startOnDemandProcess,
  waitForDocsSources,
  type DocsSourcesPayload,
  type OnDemandProcessName,
} from "./on-demand.ts";

export type ProviderName = "docker" | "fly";
export type DeploymentOwnership = "owned" | "attached";

export type DeploymentCommandResult = {
  exitCode: number;
  output: string;
};

export type HostRequestParams = {
  host: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
};

export interface DeploymentIngressOpts {
  publicBaseHost?: string;
  publicBaseHostType?: PublicIngressUrlTypeInput;
  createIngressProxyRoutes?: boolean;
  ingressProxyBaseUrl?: string;
  ingressProxyApiKey?: string;
  ingressProxyTargetUrl?: string;
}

export interface DeploymentOpts {
  name?: string;
  env?: Record<string, string> | string[];
  waitForReady?: boolean;
  readyTimeoutMs?: number;
  iterateRepoPath?: string;
  ingress?: DeploymentIngressOpts;
}

type ResolvedDeploymentIngressOpts = {
  publicBaseHost: string;
  publicBaseHostType: PublicIngressUrlType;
  createIngressProxyRoutes: boolean;
  ingressProxyBaseUrl?: string;
  ingressProxyApiKey?: string;
  ingressProxyTargetUrl: string;
};

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

const DEFAULT_ITERATE_REPO = "/home/iterate/src/github.com/iterate/iterate";

function parseEnvContent(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const entry = line.startsWith("export ") ? line.slice("export ".length) : line;
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim();
    if (!key) continue;
    env[key] = entry.slice(separator + 1);
  }
  return env;
}

function serializeEnvContent(env: Record<string, string>): string {
  const lines = Object.keys(env)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${key}=${env[key] ?? ""}`);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function extractIterateServiceName(host: string): string | null {
  const normalized = host.trim().toLowerCase();
  const match = /^([a-z0-9-]+)\.iterate\.localhost$/.exec(normalized);
  return match?.[1] ?? null;
}

async function callIngressProxyProcedure<T>(params: {
  baseUrl: string;
  apiKey: string;
  name: string;
  input: unknown;
}): Promise<T> {
  const response = await fetch(`${params.baseUrl}/api/orpc/${params.name}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ json: params.input }),
  });

  const payload = (await response.json().catch(() => ({}))) as { json?: T };
  if (!response.ok) {
    throw new Error(
      `ingress proxy ${params.name} failed (${response.status}): ${JSON.stringify(payload)}`,
    );
  }
  if (payload.json === undefined) {
    throw new Error(`ingress proxy ${params.name} returned no json payload`);
  }

  return payload.json;
}

export async function waitForHttpOk(params: { url: string; timeoutMs?: number }): Promise<void> {
  await pWaitFor(
    async () => {
      const response = await fetch(params.url).catch(() => null);
      return response?.ok ?? false;
    },
    {
      interval: 150,
      timeout: {
        milliseconds: params.timeoutMs ?? 10_000,
        message: `timed out waiting for healthy endpoint: ${params.url}`,
      },
    },
  );
}

type ProviderStartResult<TLocator> = {
  locator: TLocator;
  defaultIngressOpts: DeploymentIngressOpts;
  cleanupOnError: () => Promise<void>;
};

export abstract class Deployment<
  TOpts extends DeploymentOpts = DeploymentOpts,
  TLocator = unknown,
> implements AsyncDisposable {
  static implemented = false;

  protected state: "new" | "running" | "destroyed" = "new";
  protected ownership: DeploymentOwnership | null = null;
  protected deploymentLocator: TLocator | null = null;

  public ports: { ingress: number } = { ingress: 0 };
  public pidnap!: PidnapClient;
  public caddy!: CaddyClient;
  public registry!: RegistryClient;

  private homeEnvFilePath: string | null = null;
  private eventsClient: DeploymentEventsClient | null = null;
  private ingressConfig: ResolvedDeploymentIngressOpts | null = null;
  private ingressProxyRoute: { baseUrl: string; apiKey: string; routeId: string } | null = null;
  private startupOpts: DeploymentOpts | null = null;
  private defaultIngressOpts: DeploymentIngressOpts | null = null;

  protected abstract readonly providerName: ProviderName;

  protected abstract providerCreate(opts: TOpts): Promise<ProviderStartResult<TLocator>>;
  protected abstract providerAttach(
    locator: TLocator,
    opts?: Partial<TOpts>,
  ): Promise<Pick<ProviderStartResult<TLocator>, "defaultIngressOpts" | "cleanupOnError">>;
  protected abstract providerRestart(): Promise<void>;
  protected abstract providerDisposeOwned(): Promise<void>;
  protected abstract providerIngressUrl(): Promise<string>;
  protected abstract providerExec(cmd: string | string[]): Promise<DeploymentCommandResult>;
  protected abstract providerLogs(): Promise<string>;

  protected async providerDisposeAttached(): Promise<void> {
    // optional
  }

  protected assertRunning(): void {
    if (this.state !== "running") {
      throw new Error(`${this.constructor.name} is not running`);
    }
  }

  private clearLocalState(): void {
    this.deploymentLocator = null;
    this.homeEnvFilePath = null;
    this.ownership = null;
    this.eventsClient = null;
    this.ingressConfig = null;
    this.ingressProxyRoute = null;
    this.startupOpts = null;
    this.defaultIngressOpts = null;
    this.ports = { ingress: 0 };
  }

  private async resolveIngressConfig(opts: DeploymentOpts): Promise<ResolvedDeploymentIngressOpts> {
    const defaults = this.defaultIngressOpts ?? {};
    const provided = opts.ingress ?? {};
    const merged: DeploymentIngressOpts = {
      ...defaults,
      ...provided,
    };

    const hasPublicBaseUrl = Boolean(merged.publicBaseHost?.trim());
    const hasIngressTarget = Boolean(merged.ingressProxyTargetUrl?.trim());
    const needsRuntimeIngress = !hasPublicBaseUrl || !hasIngressTarget;
    const runtimeIngressUrl = needsRuntimeIngress ? await this.providerIngressUrl() : undefined;
    const publicBaseHost = merged.publicBaseHost?.trim() || runtimeIngressUrl || "";
    const publicBaseHostType = normalizePublicIngressUrlType(merged.publicBaseHostType);
    const createIngressProxyRoutes = merged.createIngressProxyRoutes ?? false;
    const ingressProxyBaseUrl = merged.ingressProxyBaseUrl?.trim();
    const ingressProxyApiKey = merged.ingressProxyApiKey?.trim();
    const ingressProxyTargetUrl = merged.ingressProxyTargetUrl?.trim() || runtimeIngressUrl || "";

    return {
      publicBaseHost,
      publicBaseHostType,
      createIngressProxyRoutes,
      ingressProxyBaseUrl,
      ingressProxyApiKey,
      ingressProxyTargetUrl,
    };
  }

  private async ensureIngressProxyRoute(config: ResolvedDeploymentIngressOpts): Promise<void> {
    if (!config.createIngressProxyRoutes) return;
    if (!config.ingressProxyBaseUrl) {
      throw new Error("createIngressProxyRoutes=true requires ingressProxyBaseUrl");
    }
    if (!config.ingressProxyApiKey) {
      throw new Error("createIngressProxyRoutes=true requires ingressProxyApiKey");
    }

    const baseHost = new URL(config.publicBaseHost).hostname;
    const wildcardPattern =
      config.publicBaseHostType === "prefix" ? `*__${baseHost}` : `*.${baseHost}`;
    const routeTargetHost = new URL(config.ingressProxyTargetUrl).host;
    const patterns = [
      {
        pattern: baseHost,
        target: config.ingressProxyTargetUrl,
        headers: {
          Host: routeTargetHost,
        },
      },
      {
        pattern: wildcardPattern,
        target: config.ingressProxyTargetUrl,
        headers: {
          Host: routeTargetHost,
        },
      },
    ];

    const route = await callIngressProxyProcedure<{ routeId: string }>({
      baseUrl: config.ingressProxyBaseUrl,
      apiKey: config.ingressProxyApiKey,
      name: "createRoute",
      input: {
        metadata: {
          source: "jonasland-base-deployment",
          provider: this.providerName,
          publicBaseHost: config.publicBaseHost,
          publicBaseHostType: config.publicBaseHostType,
        },
        patterns,
      },
    });

    this.ingressProxyRoute = {
      baseUrl: config.ingressProxyBaseUrl,
      apiKey: config.ingressProxyApiKey,
      routeId: route.routeId,
    };
  }

  private async deleteIngressProxyRouteIfNeeded(): Promise<void> {
    const route = this.ingressProxyRoute;
    if (!route) return;
    this.ingressProxyRoute = null;
    await callIngressProxyProcedure<{ deleted: boolean }>({
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      name: "deleteRoute",
      input: {
        routeId: route.routeId,
      },
    }).catch(() => {});
  }

  private async configureIngressForCurrentRuntime(opts: DeploymentOpts): Promise<void> {
    this.ingressConfig = await this.resolveIngressConfig(opts);
    await this.ensureIngressProxyRoute(this.ingressConfig);
  }

  private async waitForStartupReady(opts: DeploymentOpts): Promise<void> {
    if (opts.waitForReady ?? true) {
      const readyTimeoutMs = opts.readyTimeoutMs ?? 120_000;
      await this.waitForPidnapHostRoute({ timeoutMs: readyTimeoutMs });
      await this.waitForDirectHttp({
        url: "http://127.0.0.1/",
        timeoutMs: readyTimeoutMs,
      });
    }
  }

  private async startDeployment(params: {
    locator: TLocator;
    ownership: DeploymentOwnership;
    opts: DeploymentOpts;
    started: Pick<ProviderStartResult<TLocator>, "defaultIngressOpts" | "cleanupOnError">;
  }): Promise<void> {
    this.deploymentLocator = params.locator;
    this.ownership = params.ownership;
    this.defaultIngressOpts = params.started.defaultIngressOpts;
    this.startupOpts = params.opts;

    try {
      await this.configureIngressForCurrentRuntime(params.opts);
      await this.waitForStartupReady(params.opts);
      this.state = "running";
    } catch (error) {
      await this.deleteIngressProxyRouteIfNeeded();
      await params.started.cleanupOnError().catch(() => {});
      this.clearLocalState();
      throw error;
    }
  }

  async create(opts: TOpts): Promise<TLocator> {
    if (this.state === "destroyed") {
      throw new Error(`${this.constructor.name} has been destroyed`);
    }
    if (this.state === "running") {
      throw new Error(`${this.constructor.name} is already running`);
    }

    const startupOpts: DeploymentOpts = {
      ...opts,
      ingress: opts.ingress ? { ...opts.ingress } : undefined,
    };
    const started = await this.providerCreate(opts);
    await this.startDeployment({
      locator: started.locator,
      ownership: "owned",
      opts: startupOpts,
      started,
    });

    return started.locator;
  }

  async attach(locator: TLocator, opts: Partial<TOpts> = {}): Promise<void> {
    if (this.state === "destroyed") {
      throw new Error(`${this.constructor.name} has been destroyed`);
    }
    if (this.state === "running") {
      throw new Error(`${this.constructor.name} is already running`);
    }

    const startupOpts: DeploymentOpts = {
      ...opts,
      ingress: opts.ingress ? { ...opts.ingress } : undefined,
    };
    const started = await this.providerAttach(locator, opts);
    await this.startDeployment({
      locator,
      ownership: "attached",
      opts: startupOpts,
      started,
    });
  }

  getDeploymentLocator(): TLocator {
    if (this.deploymentLocator == null) {
      throw new Error(`${this.constructor.name} has no deploymentLocator`);
    }
    return this.deploymentLocator;
  }

  async restart(): Promise<void> {
    this.assertRunning();
    await this.providerRestart();

    const opts = this.startupOpts ?? {};
    await this.deleteIngressProxyRouteIfNeeded();
    await this.configureIngressForCurrentRuntime(opts);
    await this.waitForStartupReady(opts);
  }

  async destroy(): Promise<void> {
    if (this.state === "destroyed") return;

    await this.deleteIngressProxyRouteIfNeeded();

    if (this.state === "running") {
      if (this.ownership === "owned") {
        await this.providerDisposeOwned();
      } else {
        await this.providerDisposeAttached();
      }
    }

    this.clearLocalState();
    this.state = "destroyed";
  }

  async ingressUrl(): Promise<string> {
    if (this.ingressConfig) {
      return this.ingressConfig.publicBaseHost;
    }
    return await this.providerIngressUrl();
  }

  async exec(cmd: string | string[]): Promise<DeploymentCommandResult> {
    return await this.providerExec(cmd);
  }

  async logs(): Promise<string> {
    return await this.providerLogs();
  }

  async waitForHealthyWithLogs(params?: { timeoutMs?: number }): Promise<void> {
    try {
      const ingress = await this.ingressUrl();
      await waitForHttpOk({
        url: `${ingress}/__iterate/caddy-health`,
        timeoutMs: params?.timeoutMs ?? 45_000,
      });
    } catch (error) {
      const logs = await this.logs().catch(() => "(deployment logs unavailable)");
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\ndeployment logs:\n${logs}`,
      );
    }
  }

  async waitForCaddyHealthy(params?: { timeoutMs?: number }): Promise<void> {
    const ingress = await this.ingressUrl();
    await waitForHttpOk({
      url: `${ingress}/`,
      timeoutMs: params?.timeoutMs ?? 45_000,
    });
  }

  async waitForPidnapHostRoute(params?: { timeoutMs?: number }): Promise<void> {
    await pWaitFor(
      async () => {
        const result = await this.exec(
          "curl -fsS -X POST -H 'Host: pidnap.iterate.localhost' -H 'Content-Type: application/json' --data '{}' http://127.0.0.1/rpc/processes/list",
        ).catch(() => ({ exitCode: 1, output: "" }));
        return result.exitCode === 0 && result.output.includes('"name":"caddy"');
      },
      {
        interval: 250,
        timeout: {
          milliseconds: params?.timeoutMs ?? 45_000,
          message: "timed out waiting for pidnap host route",
        },
      },
    );
  }

  async assertIptablesRedirect(): Promise<void> {
    const natRules = await this.exec("sudo iptables -t nat -S OUTPUT");
    if (natRules.exitCode !== 0) {
      throw new Error(`failed to inspect iptables nat rules:\n${natRules.output}`);
    }
    if (!natRules.output.includes("--dport 80 -j REDIRECT --to-ports 80")) {
      throw new Error(`missing iptables redirect for :80:\n${natRules.output}`);
    }
    if (!natRules.output.includes("--dport 443 -j REDIRECT --to-ports 443")) {
      throw new Error(`missing iptables redirect for :443:\n${natRules.output}`);
    }
  }

  async waitForPidnapProcessRunning(params: { target: string | number; timeoutMs?: number }) {
    this.assertRunning();
    const processSlug = typeof params.target === "string" ? params.target : String(params.target);
    const timeoutMs = params.timeoutMs ?? 45_000;
    const result = await this.pidnap.processes.waitForRunning({
      processSlug,
      timeoutMs,
      pollIntervalMs: 250,
      includeLogs: true,
      logTailLines: 120,
    });

    if (result.state === "running") return;

    throw new Error(
      `pidnap process "${processSlug}" did not become running (state=${result.state}, elapsedMs=${String(result.elapsedMs)}, restarts=${String(result.restarts)})\n${result.logs ?? ""}`,
    );
  }

  async request(params: HostRequestParams): Promise<Response> {
    const targetUrl = new URL(
      `http://127.0.0.1${params.path.startsWith("/") ? params.path : `/${params.path}`}`,
    );
    const method = (params.method ?? "GET").toUpperCase();
    const headers = new Headers(params.headers);

    if (params.json !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const bodyString = params.json !== undefined ? JSON.stringify(params.json) : params.body;
    const body = bodyString === undefined ? undefined : Buffer.from(bodyString);

    const request = new Request(targetUrl, {
      method,
      headers,
      body,
    });
    return await this.fetchWithHost(request, params.host);
  }

  async waitForHostRoute(params: {
    host: string;
    path: string;
    timeoutMs?: number;
    readyStatus?: "ok" | "lt400";
  }): Promise<void> {
    const readyStatus = params.readyStatus ?? "ok";
    await pWaitFor(
      async () => {
        const response = await this.request({ host: params.host, path: params.path }).catch(
          () => undefined,
        );
        if (!response) return false;
        return readyStatus === "ok" ? response.ok : response.status < 400;
      },
      {
        interval: 200,
        timeout: {
          milliseconds: params.timeoutMs ?? 45_000,
          message: `timed out waiting for host route ${params.host}${params.path}`,
        },
      },
    );
  }

  async fetchWithHost(request: Request, host: string): Promise<Response> {
    const requestUrl = new URL(request.url);
    const isIterateServiceHost = extractIterateServiceName(host) !== null;
    const method = request.method.toUpperCase();
    const headers = new Headers(request.headers);
    const runtimeIngressUrl = await this.providerIngressUrl();
    let targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, runtimeIngressUrl);

    if (isIterateServiceHost && this.ingressConfig) {
      const publicServiceUrl = new URL(
        resolvePublicIngressUrl({
          publicBaseHost: this.ingressConfig.publicBaseHost,
          publicBaseHostType: this.ingressConfig.publicBaseHostType,
          internalUrl: `http://${host}${requestUrl.pathname}${requestUrl.search}`,
        }),
      );

      if (!publicServiceUrl.hostname.toLowerCase().endsWith(".iterate.localhost")) {
        targetUrl = publicServiceUrl;
      }
    }

    headers.delete("host");
    headers.set("x-forwarded-host", host);
    headers.set("x-forwarded-proto", targetUrl.protocol.replace(/:$/, "").toLowerCase());
    headers.delete("content-length");

    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : Buffer.from(await request.clone().arrayBuffer());

    if (body !== undefined) {
      headers.set("content-length", body.byteLength.toString());
    }

    return await pRetry(() => nodeHttpRequest({ url: targetUrl, method, headers, body }), {
      retries: 9,
      shouldRetry: isRetriableNetworkError,
      minTimeout: 200,
      maxTimeout: 1_500,
    });
  }

  createOrpcClient<TClient>(params: {
    host: string;
    path: "/rpc" | "/orpc";
    create: (options: { url: string; fetch: (request: Request) => Promise<Response> }) => TClient;
  }): TClient {
    return params.create({
      url: `http://${params.host}${params.path}`,
      fetch: async (request: Request) => await this.fetchWithHost(request, params.host),
    });
  }

  get events(): DeploymentEventsClient {
    this.assertRunning();
    if (this.eventsClient) return this.eventsClient;

    const eventsClient = this.createOrpcClient({
      host: "events.iterate.localhost",
      path: "/orpc",
      create: ({ url, fetch }) =>
        createOrpcRpcServiceClient({
          env: {},
          manifest: eventsServiceManifest,
          url,
          fetch,
        }),
    }) as DeploymentEventsClient;

    this.eventsClient = eventsClient;
    return eventsClient;
  }

  createServiceOrpcClient<TContract extends AnyContractRouter>(params: {
    manifest: ServiceManifestLike<TContract>;
    host?: string;
  }): ContractRouterClient<TContract> {
    const host = params.host ?? localHostForService({ slug: params.manifest.slug });
    return this.createOrpcClient({
      host,
      path: "/orpc",
      create: ({ url, fetch }) =>
        createOrpcRpcServiceClient({
          env: {},
          manifest: params.manifest,
          url,
          fetch,
        }),
    });
  }

  async startServiceFromManifest<TContract extends AnyContractRouter>(params: {
    manifest: ServiceManifestWithEntryPoint<TContract>;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<ContractRouterClient<TContract>> {
    this.assertRunning();
    await this.pidnap.processes.updateConfig(serviceManifestToPidnapConfig(params));
    await this.pidnap.processes.waitForRunning({
      processSlug: params.manifest.slug,
      timeoutMs: params.timeoutMs ?? 60_000,
    });
    return this.createServiceOrpcClient({ manifest: params.manifest });
  }

  async readEnvFile(): Promise<Record<string, string>> {
    const envFilePath = await this.resolveHomeEnvFilePath();
    const result = await this.exec([
      "sh",
      "-ec",
      `if [ -f ${shQuote(envFilePath)} ]; then cat ${shQuote(envFilePath)}; fi`,
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`failed reading env file ${envFilePath}:\n${result.output}`);
    }

    return parseEnvContent(result.output);
  }

  async writeEnvFile(params: {
    env: Record<string, string>;
    mode?: "overwrite" | "merge";
  }): Promise<Record<string, string>> {
    const envFilePath = await this.resolveHomeEnvFilePath();
    const current = params.mode === "merge" ? await this.readEnvFile() : {};
    const env = {
      ...current,
      ...params.env,
    };

    for (const [key, value] of Object.entries(env)) {
      if (value === undefined || value === null) {
        delete env[key];
      }
    }

    const content = serializeEnvContent(env);
    const command = [
      `mkdir -p ${shQuote(envFilePath.replace(/\/[^/]+$/, ""))}`,
      `cat > ${shQuote(envFilePath)} <<'EOF'`,
      content,
      "EOF",
      `chmod 600 ${shQuote(envFilePath)}`,
    ].join("\n");

    const result = await this.exec(["sh", "-ec", command]);
    if (result.exitCode !== 0) {
      throw new Error(`failed writing env file ${envFilePath}:\n${result.output}`);
    }

    return env;
  }

  async mergeEnvFile(env: Record<string, string>): Promise<Record<string, string>> {
    return await this.writeEnvFile({ env, mode: "merge" });
  }

  private async waitForDirectHttp(params: { url: string; timeoutMs?: number }): Promise<void> {
    await pWaitFor(
      async () => {
        const result = await this.exec(`curl -fsS '${params.url}' >/dev/null`).catch(() => ({
          exitCode: 1,
          output: "",
        }));
        return result.exitCode === 0;
      },
      {
        interval: 200,
        timeout: {
          milliseconds: params.timeoutMs ?? 45_000,
          message: `timed out waiting for direct http ${params.url}`,
        },
      },
    );
  }

  async startOnDemandProcess(processName: OnDemandProcessName): Promise<void> {
    this.assertRunning();
    await startOnDemandProcess({
      deployment: this,
      processName,
      processConfig: onDemandProcesses[processName],
      waitForHostRoute: this.waitForHostRoute.bind(this),
      waitForDirectHttp: this.waitForDirectHttp.bind(this),
    });
  }

  async waitForDocsSources(expectedHosts: string[]): Promise<DocsSourcesPayload> {
    return await waitForDocsSources({
      expectedHosts,
      fetchSources: async () => {
        const response = await this.request({
          host: "docs.iterate.localhost",
          path: "/api/openapi-sources",
        }).catch(() => undefined);
        if (!response?.ok) return undefined;
        return (await response.json().catch(() => undefined)) as DocsSourcesPayload | undefined;
      },
    });
  }

  async ensureEgressProxyProcess(params?: { externalProxyUrl?: string }): Promise<void> {
    this.assertRunning();
    const externalProxyUrl = params?.externalProxyUrl?.trim() || "";
    const iterateRepo =
      this.startupOpts?.iterateRepoPath?.trim() || process.env.ITERATE_REPO || DEFAULT_ITERATE_REPO;

    const processEnv: Record<string, string> = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
      OTEL_PROPAGATORS: "tracecontext,baggage",
    };
    if (externalProxyUrl) {
      processEnv.EXTERNAL_PROXY_URL = externalProxyUrl;
    }

    const processDefinition = {
      command: "sh",
      args: [
        "-lc",
        `/opt/pidnap/node_modules/.bin/tsx ${iterateRepo}/services/egress-service/src/server.ts`,
      ],
      env: processEnv,
    };

    const configPayload = {
      processSlug: "egress-proxy",
      definition: processDefinition,
      options: {
        restartPolicy: "always" as const,
      },
      envOptions: {
        reloadDelay: false,
      },
    };

    const startPayload = {
      target: "egress-proxy",
    };

    await pRetry(
      async () => {
        await this.pidnap.processes.updateConfig(configPayload);
        await this.pidnap.processes.start(startPayload).catch(() => {});
        await this.waitForPidnapProcessRunning({
          target: "egress-proxy",
          timeoutMs: 120_000,
        });
        await this.waitForDirectHttp({
          url: "http://127.0.0.1:19000/__iterate/health",
          timeoutMs: 120_000,
        });
      },
      { retries: 5 },
    ).catch(async (originalError) => {
      await pRetry(
        async () => {
          await this.exec([
            "sh",
            "-ec",
            [
              "curl -fsS -X POST",
              "-H 'Host: pidnap.iterate.localhost'",
              "-H 'content-type: application/json'",
              `--data ${shQuote(JSON.stringify(configPayload))}`,
              "http://127.0.0.1/rpc/processes/updateConfig >/dev/null",
            ].join(" "),
          ]);
          await this.exec([
            "sh",
            "-ec",
            [
              "curl -fsS -X POST",
              "-H 'Host: pidnap.iterate.localhost'",
              "-H 'content-type: application/json'",
              `--data ${shQuote(JSON.stringify(startPayload))}`,
              "http://127.0.0.1/rpc/processes/start >/dev/null 2>&1 || true",
            ].join(" "),
          ]).catch(() => {});
          await this.waitForDirectHttp({
            url: "http://127.0.0.1:19000/__iterate/health",
            timeoutMs: 120_000,
          });
        },
        { retries: 5 },
      ).catch((fallbackError) => {
        throw new Error(
          `egress-proxy configuration failed via pidnap client and fallback exec path (${this.providerName})`,
          { cause: fallbackError ?? originalError },
        );
      });
    });
  }

  async useEgressProxy(proxy: { proxyUrl: string }): Promise<void> {
    await this.ensureEgressProxyProcess({ externalProxyUrl: proxy.proxyUrl });
  }

  async providerStatus(): Promise<"new" | "running" | "destroyed"> {
    return this.state;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.destroy();
  }

  toJSON() {
    return {
      kind: this.constructor.name,
      provider: this.providerName,
      state: this.state,
      ownership: this.ownership,
      deploymentLocator: this.deploymentLocator,
    };
  }

  private async resolveHomeEnvFilePath(): Promise<string> {
    if (this.homeEnvFilePath) return this.homeEnvFilePath;

    const homeResult = await this.exec([
      "sh",
      "-ec",
      [
        'if [ -d "/home/iterate" ]; then',
        "  printf %s /home/iterate",
        'elif [ -n "${HOME:-}" ] && [ "${HOME}" != "/" ]; then',
        '  printf %s "$HOME"',
        "else",
        "  printf %s /home/iterate",
        "fi",
      ].join("\n"),
    ]);

    if (homeResult.exitCode !== 0) {
      throw new Error(`failed to resolve HOME inside deployment:\n${homeResult.output}`);
    }

    const home = homeResult.output.trim();
    if (!home) {
      throw new Error("failed to resolve HOME inside deployment: empty result");
    }

    this.homeEnvFilePath = `${home}/.iterate/.env`;
    return this.homeEnvFilePath;
  }
}
