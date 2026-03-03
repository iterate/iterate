import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import {
  type EventBusContract,
  serviceManifest as eventsServiceManifest,
} from "@iterate-com/events-contract";
import { type AnyContractRouter, type ContractRouterClient } from "@orpc/contract";
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
import {
  dockerDeploymentRuntimeAttach,
  dockerDeploymentRuntimeCreate,
  type DeploymentRuntime,
  type DockerDeploymentLocator,
} from "./docker-deployment.ts";
import {
  flyDeploymentRuntimeAttach,
  flyDeploymentRuntimeCreate,
  type FlyDeploymentLocator,
} from "./fly-deployment.ts";
export type { DeploymentRuntime, SandboxFixture } from "./docker-deployment.ts";

export type ProviderName = "docker" | "fly";

export type DeploymentCommandResult = {
  exitCode: number;
  output: string;
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

export interface DeploymentCreateInputCommon {
  name: string;
  env?: Record<string, string> | string[];
  waitForReady?: boolean;
  readyTimeoutMs?: number;
  ingress?: DeploymentIngressInput;
}

export interface DockerDeploymentCreateInput extends DeploymentCreateInputCommon {
  dockerImage: string;
  extraHosts?: string[];
  capAdd?: string[];
  ingressHostPort?: number;
}

export interface FlyDeploymentCreateInput extends DeploymentCreateInputCommon {
  flyImage: string;
}

export type DeploymentLocator = DockerDeploymentLocator | FlyDeploymentLocator;

export type DeploymentOwnership = "owned" | "attached";

export interface DeploymentIngressInput {
  publicBaseUrl?: string;
  publicBaseUrlType?: PublicIngressUrlTypeInput;
  createIngressProxyRoutes?: boolean;
  ingressProxyBaseUrl?: string;
  ingressProxyApiKey?: string;
  ingressProxyTargetUrl?: string;
}

type ResolvedDeploymentIngressConfig = {
  publicBaseUrl: string;
  publicBaseUrlType: PublicIngressUrlType;
  createIngressProxyRoutes: boolean;
  ingressProxyBaseUrl?: string;
  ingressProxyApiKey?: string;
  ingressProxyTargetUrl: string;
};

const EGRESS_PROCESS_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
};
const DEFAULT_ITERATE_REPO = "/home/iterate/src/github.com/iterate/iterate";
const DEFAULT_INGRESS_PROXY_BASE_URL = "https://ingress.iterate.com";

function parseEnvContent(content: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const entry = line.startsWith("export ") ? line.slice("export ".length) : line;
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;

    const key = entry.slice(0, separator).trim();
    if (key.length === 0) continue;

    const value = entry.slice(separator + 1);
    env[key] = value;
  }

  return env;
}

function serializeEnvContent(env: Record<string, string>): string {
  const lines = Object.keys(env)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${key}=${env[key] ?? ""}`);

  if (lines.length === 0) return "";
  return `${lines.join("\n")}\n`;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function requestErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;

  if ("code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }

  if ("cause" in error && (error as { cause?: unknown }).cause) {
    return requestErrorCode((error as { cause: unknown }).cause);
  }

  return undefined;
}

function isRetriableRequestError(error: unknown): boolean {
  const code = requestErrorCode(error);
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  ) {
    return true;
  }

  if (error instanceof Error && /socket hang up/i.test(error.message)) {
    return true;
  }

  return false;
}

function extractIterateServiceName(host: string): string | null {
  const normalized = host.trim().toLowerCase();
  const match = /^([a-z0-9-]+)\.iterate\.localhost$/.exec(normalized);
  return match?.[1] ?? null;
}

function serviceHostFromManifestSlug(slug: string): string {
  return localHostForService({ slug });
}

async function requestWithExplicitHost(params: {
  url: URL;
  method: string;
  headers: Headers;
  body?: Buffer;
}): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    const requestImpl = params.url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestImpl(
      params.url,
      {
        method: params.method,
        headers: Object.fromEntries(params.headers.entries()),
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const entry of value) {
              responseHeaders.append(key, entry);
            }
            continue;
          }
          responseHeaders.set(key, String(value));
        }

        const status = res.statusCode ?? 500;
        const responseBody =
          status === 204 || status === 304
            ? undefined
            : (Readable.toWeb(res as unknown as Readable) as ReadableStream<Uint8Array>);
        resolve(
          new Response(responseBody, {
            status,
            statusText: res.statusMessage ?? "",
            headers: responseHeaders,
          }),
        );
      },
    );

    req.on("error", reject);
    if (params.body !== undefined) {
      req.write(params.body);
    }
    req.end();
  });
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

async function retry<T>(task: () => Promise<T>, attempts: number): Promise<T> {
  let lastError: unknown;

  for (let i = 0; i < attempts; i += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (i === attempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1)));
    }
  }

  throw lastError;
}

type RuntimeCreateResult<TDeploymentLocator extends DeploymentLocator> = {
  runtime: DeploymentRuntime;
  deploymentLocator: TDeploymentLocator;
};

abstract class DeploymentBase<
  TCreateInput extends DeploymentCreateInputCommon,
  TDeploymentLocator extends DeploymentLocator,
>
  implements AsyncDisposable, DeploymentRuntime
{
  static implemented: boolean = false;

  protected runtime: DeploymentRuntime | null = null;
  protected state: "new" | "running" | "destroyed" = "new";
  protected ownership: DeploymentOwnership | null = null;
  private homeEnvFilePath: string | null = null;
  private deploymentLocator: TDeploymentLocator | null = null;
  private eventsClient: DeploymentEventsClient | null = null;
  private ingressConfig: ResolvedDeploymentIngressConfig | null = null;
  private ingressProxyRoute: { baseUrl: string; apiKey: string; routeId: string } | null = null;

  abstract readonly providerName: ProviderName;

  protected abstract createRuntime(
    input: TCreateInput,
  ): Promise<RuntimeCreateResult<TDeploymentLocator>>;
  protected abstract attachRuntime(locator: TDeploymentLocator): Promise<DeploymentRuntime>;
  protected async resolveDefaultIngressInput(_params: {
    input: TCreateInput;
    createResult: RuntimeCreateResult<TDeploymentLocator>;
  }): Promise<DeploymentIngressInput> {
    return {};
  }

  protected requireRuntime(): DeploymentRuntime {
    if (!this.runtime) {
      throw new Error(`${this.constructor.name} is not initialized`);
    }
    return this.runtime;
  }

  get ports() {
    return this.requireRuntime().ports;
  }

  set ports(value: DeploymentRuntime["ports"]) {
    this.requireRuntime().ports = value;
  }

  get pidnap() {
    return this.requireRuntime().pidnap;
  }

  set pidnap(value: DeploymentRuntime["pidnap"]) {
    this.requireRuntime().pidnap = value;
  }

  get caddy() {
    return this.requireRuntime().caddy;
  }

  set caddy(value: DeploymentRuntime["caddy"]) {
    this.requireRuntime().caddy = value;
  }

  get registry() {
    return this.requireRuntime().registry;
  }

  set registry(value: DeploymentRuntime["registry"]) {
    this.requireRuntime().registry = value;
  }

  get events(): DeploymentEventsClient {
    this.requireRuntime();
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

  protected clearLocalState(): void {
    this.runtime = null;
    this.deploymentLocator = null;
    this.homeEnvFilePath = null;
    this.ownership = null;
    this.eventsClient = null;
    this.ingressConfig = null;
    this.ingressProxyRoute = null;
  }

  private async resolveIngressConfig(params: {
    input: TCreateInput;
    createResult: RuntimeCreateResult<TDeploymentLocator>;
  }): Promise<ResolvedDeploymentIngressConfig> {
    const defaults = await this.resolveDefaultIngressInput(params);
    const provided = params.input.ingress ?? {};
    const merged: DeploymentIngressInput = {
      ...defaults,
      ...provided,
    };

    const runtimeIngressUrl = await params.createResult.runtime.ingressUrl();
    const publicBaseUrl = merged.publicBaseUrl?.trim() || runtimeIngressUrl;
    const publicBaseUrlType = normalizePublicIngressUrlType(merged.publicBaseUrlType);
    const createIngressProxyRoutes = merged.createIngressProxyRoutes ?? false;
    const ingressProxyBaseUrl = merged.ingressProxyBaseUrl?.trim();
    const ingressProxyApiKey = merged.ingressProxyApiKey?.trim();
    const ingressProxyTargetUrl = merged.ingressProxyTargetUrl?.trim() || runtimeIngressUrl;

    return {
      publicBaseUrl,
      publicBaseUrlType,
      createIngressProxyRoutes,
      ingressProxyBaseUrl,
      ingressProxyApiKey,
      ingressProxyTargetUrl,
    };
  }

  private async ensureIngressProxyRoute(config: ResolvedDeploymentIngressConfig): Promise<void> {
    if (!config.createIngressProxyRoutes) return;
    if (!config.ingressProxyBaseUrl) {
      throw new Error("createIngressProxyRoutes=true requires ingressProxyBaseUrl");
    }
    if (!config.ingressProxyApiKey) {
      throw new Error("createIngressProxyRoutes=true requires ingressProxyApiKey");
    }

    const baseHost = new URL(config.publicBaseUrl).hostname;
    const wildcardPattern =
      config.publicBaseUrlType === "prefix" ? `*__${baseHost}` : `*.${baseHost}`;
    const routeTargetHost = new URL(config.ingressProxyTargetUrl).host;
    const patterns =
      wildcardPattern === baseHost
        ? [
            {
              pattern: baseHost,
              target: config.ingressProxyTargetUrl,
              headers: {
                Host: routeTargetHost,
              },
            },
          ]
        : [
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
          publicBaseUrl: config.publicBaseUrl,
          publicBaseUrlType: config.publicBaseUrlType,
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

  async create(input: TCreateInput): Promise<TDeploymentLocator> {
    if (this.state === "destroyed") {
      throw new Error(`${this.constructor.name} has been destroyed`);
    }
    if (this.runtime) {
      throw new Error(`${this.constructor.name} already has an initialized runtime`);
    }

    const createResult = await this.createRuntime(input);
    this.runtime = createResult.runtime;
    this.deploymentLocator = createResult.deploymentLocator;
    this.ownership = "owned";
    try {
      this.ingressConfig = await this.resolveIngressConfig({
        input,
        createResult,
      });
      await this.ensureIngressProxyRoute(this.ingressConfig);
      this.state = "running";

      if (input.waitForReady ?? true) {
        const readyTimeoutMs = input.readyTimeoutMs ?? 120_000;
        await this.waitForPidnapHostRoute({ timeoutMs: readyTimeoutMs });
        await this.waitForDirectHttp({
          url: "http://127.0.0.1/",
          timeoutMs: readyTimeoutMs,
        });
      }
    } catch (error) {
      await this.deleteIngressProxyRouteIfNeeded();
      await this.runtime[Symbol.asyncDispose]().catch(() => {});
      this.clearLocalState();
      throw error;
    }

    return createResult.deploymentLocator;
  }

  async attach(locator: TDeploymentLocator): Promise<void> {
    if (this.state === "destroyed") {
      throw new Error(`${this.constructor.name} has been destroyed`);
    }
    if (this.runtime) {
      throw new Error(`${this.constructor.name} already has an initialized runtime`);
    }

    this.runtime = await this.attachRuntime(locator);
    this.deploymentLocator = locator;
    this.ownership = "attached";
    this.state = "running";
  }

  getDeploymentLocator(): TDeploymentLocator {
    if (!this.deploymentLocator) {
      throw new Error(`${this.constructor.name} has no deploymentLocator; call create() first`);
    }
    return this.deploymentLocator;
  }

  async restart(): Promise<void> {
    if (!this.runtime) {
      throw new Error(`${this.constructor.name} is not initialized`);
    }

    await this.runtime.restart();
    this.state = "running";
  }

  async destroy(): Promise<void> {
    if (this.state === "destroyed") return;

    await this.deleteIngressProxyRouteIfNeeded();

    if (this.runtime && this.ownership === "owned") {
      await this.runtime[Symbol.asyncDispose]();
    }

    this.clearLocalState();
    this.state = "destroyed";
  }

  async ingressUrl() {
    if (this.ingressConfig) {
      return this.ingressConfig.publicBaseUrl;
    }
    return await this.requireRuntime().ingressUrl();
  }

  async exec(cmd: string | string[]): Promise<DeploymentCommandResult> {
    return await this.requireRuntime().exec(cmd);
  }

  async logs() {
    return await this.requireRuntime().logs();
  }

  async waitForHealthyWithLogs(params: { url: string }) {
    await this.requireRuntime().waitForHealthyWithLogs(params);
  }

  async waitForCaddyHealthy(params?: { timeoutMs?: number }) {
    await this.requireRuntime().waitForCaddyHealthy(params);
  }

  async waitForPidnapHostRoute(params?: { timeoutMs?: number }) {
    await this.requireRuntime().waitForPidnapHostRoute(params);
  }

  async assertIptablesRedirect() {
    await this.requireRuntime().assertIptablesRedirect();
  }

  async waitForPidnapProcessRunning(params: { target: string | number; timeoutMs?: number }) {
    await this.requireRuntime().waitForPidnapProcessRunning(params);
  }

  async fetchWithHost(request: Request, host: string): Promise<Response> {
    const requestUrl = new URL(request.url);
    const serviceName = extractIterateServiceName(host);
    const method = request.method.toUpperCase();
    const headers = new Headers(request.headers);
    let targetUrl: URL;

    if (serviceName && this.ingressConfig) {
      const publicServiceUrl = new URL(
        resolvePublicIngressUrl({
          publicBaseUrl: this.ingressConfig.publicBaseUrl,
          publicBaseUrlType: this.ingressConfig.publicBaseUrlType,
          internalUrl: `http://${host}${requestUrl.pathname}${requestUrl.search}`,
        }),
      );

      if (publicServiceUrl.hostname.toLowerCase().endsWith(".iterate.localhost")) {
        const runtimeIngressUrl = await this.requireRuntime().ingressUrl();
        targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, runtimeIngressUrl);
      } else {
        targetUrl = publicServiceUrl;
      }
    } else {
      const runtimeIngressUrl = await this.requireRuntime().ingressUrl();
      targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, runtimeIngressUrl);
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

    const maxAttempts = 10;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await requestWithExplicitHost({
          url: targetUrl,
          method,
          headers,
          body,
        });
      } catch (error) {
        if (!isRetriableRequestError(error) || attempt >= maxAttempts) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(200 * attempt, 1_500)));
      }
    }

    throw new Error("unreachable");
  }

  createOrpcClient<TClient>(params: {
    host: string;
    path: "/rpc" | "/orpc";
    create: (options: { url: string; fetch: (request: Request) => Promise<Response> }) => TClient;
  }): TClient {
    return params.create({
      url: `http://${params.host}${params.path}`,
      fetch: this.getServiceFetcher(params.host),
    });
  }

  getServiceFetcher(serviceHost: string): (request: Request) => Promise<Response> {
    return async (request: Request) => await this.fetchWithHost(request, serviceHost);
  }

  createServiceOrpcClient<TContract extends AnyContractRouter>(params: {
    manifest: ServiceManifestLike<TContract>;
    host?: string;
  }): ContractRouterClient<TContract> {
    const host = params.host ?? serviceHostFromManifestSlug(params.manifest.slug);
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
    const pidnap = this.requireRuntime().pidnap;
    await pidnap.processes.updateConfig(serviceManifestToPidnapConfig(params));
    await pidnap.processes.waitForRunning({
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
      throw new Error(`failed to read ${envFilePath}:\n${result.output}`);
    }

    return parseEnvContent(result.output);
  }

  async writeEnvFile(params: {
    env: Record<string, string>;
    mode: "merge" | "replace";
  }): Promise<void> {
    const envFilePath = await this.resolveHomeEnvFilePath();
    const current = params.mode === "merge" ? await this.readEnvFile() : {};
    const next = {
      ...current,
      ...params.env,
    };

    const content = serializeEnvContent(next);
    const encoded = Buffer.from(content, "utf-8").toString("base64");
    const result = await this.exec([
      "bash",
      "-lc",
      [
        "set -euo pipefail",
        `mkdir -p \"$(dirname ${shQuote(envFilePath)})\"`,
        `TMP_FILE=\"$(mktemp ${shQuote(envFilePath + ".tmp.XXXXXX")})\"`,
        `printf '%s' ${shQuote(encoded)} | base64 -d > \"$TMP_FILE\"`,
        'chmod 0644 "$TMP_FILE"',
        'if id -u iterate >/dev/null 2>&1; then chown iterate:iterate "$TMP_FILE" || true; fi',
        `mv \"$TMP_FILE\" ${shQuote(envFilePath)}`,
        `chmod 0644 ${shQuote(envFilePath)} || true`,
        `if id -u iterate >/dev/null 2>&1; then chown iterate:iterate ${shQuote(envFilePath)} || true; fi`,
      ].join("\n"),
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`failed to write ${envFilePath}:\n${result.output}`);
    }
  }

  async setEnvVars(env: Record<string, string>): Promise<void> {
    await this.writeEnvFile({ env, mode: "merge" });
  }

  async waitForDirectHttp(params: { url: string; timeoutMs?: number }): Promise<void> {
    const timeoutMs = params.timeoutMs ?? 90_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const result = await this.exec(["curl", "-fsS", params.url]).catch(() => ({
        exitCode: 1,
        output: "",
      }));
      if (result.exitCode === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`timed out waiting for direct http ${params.url}`);
  }

  async ensureEgressProxyProcess(params?: { externalProxyUrl?: string }): Promise<void> {
    try {
      await retry(async () => {
        const envFilePath = await this.resolveHomeEnvFilePath();
        if (params?.externalProxyUrl) {
          await this.setEnvVars({ ITERATE_EXTERNAL_EGRESS_PROXY: params.externalProxyUrl });
        }

        const existing = await this.pidnap.processes
          .get({
            target: "egress-proxy",
            includeEffectiveEnv: false,
          })
          .catch(() => null);
        const docsProcess = await this.pidnap.processes
          .get({
            target: "docs",
            includeEffectiveEnv: false,
          })
          .catch(() => null);
        const fallbackTsxCommand =
          docsProcess?.definition.command ??
          `${DEFAULT_ITERATE_REPO}/packages/pidnap/node_modules/.bin/tsx`;

        const definition = {
          command: existing?.definition.command ?? fallbackTsxCommand,
          args: existing?.definition.args ?? [
            `${DEFAULT_ITERATE_REPO}/services/egress-service/src/server.ts`,
          ],
          env: {
            ...(existing?.definition.env ?? {}),
            ...EGRESS_PROCESS_ENV,
          },
        };

        const updated = await this.pidnap.processes.updateConfig({
          processSlug: "egress-proxy",
          definition,
          options: {
            restartPolicy: "always",
          },
          envOptions: {
            envFile: envFilePath,
            reloadDelay: true,
          },
          restartImmediately: true,
        });

        if (updated.state !== "running") {
          await this.pidnap.processes.start({ target: "egress-proxy" });
        }

        await this.waitForPidnapProcessRunning({
          target: "egress-proxy",
          timeoutMs: 120_000,
        });
        await this.waitForDirectHttp({
          url: "http://127.0.0.1:19000/healthz",
          timeoutMs: 120_000,
        });
      }, 8);
    } catch (error) {
      if (this.providerName !== "fly") {
        throw error;
      }
      await this.ensureEgressProxyProcessViaExec(params, error);
    }
  }

  private async ensureEgressProxyProcessViaExec(
    params: { externalProxyUrl?: string } | undefined,
    originalError: unknown,
  ): Promise<void> {
    await retry(async () => {
      const envFilePath = await this.resolveHomeEnvFilePath();
      if (params?.externalProxyUrl) {
        await this.setEnvVars({ ITERATE_EXTERNAL_EGRESS_PROXY: params.externalProxyUrl });
      }

      const updatePayload = JSON.stringify({
        json: {
          processSlug: "egress-proxy",
          definition: {
            command: "/opt/pidnap/node_modules/.bin/tsx",
            args: ["/opt/services/egress-service/src/server.ts"],
            env: EGRESS_PROCESS_ENV,
          },
          options: {
            restartPolicy: "always",
          },
          envOptions: {
            envFile: envFilePath,
            reloadDelay: true,
          },
          restartImmediately: true,
        },
      });

      const updateResult = await this.exec([
        "sh",
        "-ec",
        [
          "curl -fsS -X POST",
          "-H 'Host: pidnap.iterate.localhost'",
          "-H 'content-type: application/json'",
          `--data ${shQuote(updatePayload)}`,
          "http://127.0.0.1/rpc/processes/updateConfig",
        ].join(" "),
      ]);

      if (updateResult.exitCode !== 0) {
        throw new Error(
          `pidnap local updateConfig failed while configuring egress-proxy:\n${updateResult.output}`,
        );
      }

      const startPayload = JSON.stringify({
        json: {
          target: "egress-proxy",
        },
      });
      await this.exec([
        "sh",
        "-ec",
        [
          "curl -fsS -X POST",
          "-H 'Host: pidnap.iterate.localhost'",
          "-H 'content-type: application/json'",
          `--data ${shQuote(startPayload)}`,
          "http://127.0.0.1/rpc/processes/start >/dev/null 2>&1 || true",
        ].join(" "),
      ]).catch(() => {});

      await this.waitForDirectHttp({
        url: "http://127.0.0.1:19000/healthz",
        timeoutMs: 120_000,
      });
    }, 6).catch((fallbackError) => {
      throw new Error(
        `egress-proxy configuration failed via pidnap client and fallback exec path (${this.providerName})`,
        { cause: fallbackError ?? originalError },
      );
    });
  }

  async useEgressProxy(proxy: { proxyUrl: string }): Promise<void> {
    await this.ensureEgressProxyProcess({ externalProxyUrl: proxy.proxyUrl });
  }

  async providerExec(cmd: string | string[]): Promise<DeploymentCommandResult> {
    return await this.exec(cmd);
  }

  async providerLogs() {
    return await this.logs();
  }

  async providerStatus() {
    return this.state;
  }

  async [Symbol.asyncDispose]() {
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
    if (home.length === 0) {
      throw new Error("failed to resolve HOME inside deployment: empty result");
    }

    this.homeEnvFilePath = `${home}/.iterate/.env`;
    return this.homeEnvFilePath;
  }
}

export abstract class Deployment<
  TCreateInput extends DeploymentCreateInputCommon = DeploymentCreateInputCommon,
  TDeploymentLocator extends DeploymentLocator = DeploymentLocator,
> extends DeploymentBase<TCreateInput, TDeploymentLocator> {
  static override implemented: boolean = false;
}

function mergeCreateInput<TInput>(baseInput: TInput, override?: Partial<TInput>): TInput {
  if (!override) return { ...(baseInput as object) } as TInput;
  return { ...(baseInput as object), ...(override as object) } as TInput;
}

type RequiredKeys<T> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];

type CreateWithConfigInput<TAll, TProvided extends Partial<TAll>> = Omit<TAll, keyof TProvided> &
  Partial<Pick<TAll, Extract<keyof TProvided, keyof TAll>>>;

type RemainingRequiredKeys<TAll, TProvided extends Partial<TAll>> = Exclude<
  RequiredKeys<TAll>,
  keyof TProvided
>;

type CreateWithConfigArgs<TAll, TProvided extends Partial<TAll>> =
  RemainingRequiredKeys<TAll, TProvided> extends never
    ? [override?: CreateWithConfigInput<TAll, TProvided>]
    : [override: CreateWithConfigInput<TAll, TProvided>];

export class DockerDeployment extends Deployment<
  DockerDeploymentCreateInput,
  DockerDeploymentLocator
> {
  static override implemented: boolean = true;

  readonly providerName = "docker";

  protected override async resolveDefaultIngressInput(params: {
    input: DockerDeploymentCreateInput;
    createResult: RuntimeCreateResult<DockerDeploymentLocator>;
  }): Promise<DeploymentIngressInput> {
    const runtimeIngressUrl = await params.createResult.runtime.ingressUrl();
    const runtimeIngress = new URL(runtimeIngressUrl);
    const port = runtimeIngress.port || (runtimeIngress.protocol === "https:" ? "443" : "80");
    const publicBaseUrl = `http://iterate.localhost:${port}`;

    return {
      publicBaseUrl,
      publicBaseUrlType: "subdomain",
      createIngressProxyRoutes: false,
      ingressProxyTargetUrl: runtimeIngressUrl,
    };
  }

  protected override async createRuntime(
    input: DockerDeploymentCreateInput,
  ): Promise<RuntimeCreateResult<DockerDeploymentLocator>> {
    return await dockerDeploymentRuntimeCreate(input);
  }

  protected override async attachRuntime(
    locator: DockerDeploymentLocator,
  ): Promise<DeploymentRuntime> {
    return await dockerDeploymentRuntimeAttach(locator);
  }

  static async create(input: DockerDeploymentCreateInput): Promise<DockerDeployment> {
    const deployment = new DockerDeployment();
    await deployment.create(input);
    return deployment;
  }

  static createWithConfig<TProvided extends Partial<DockerDeploymentCreateInput>>(
    baseInput: TProvided,
  ) {
    const create = async (
      ...args: CreateWithConfigArgs<DockerDeploymentCreateInput, TProvided>
    ): Promise<DockerDeployment> => {
      const override = args[0];
      return await DockerDeployment.create(
        mergeCreateInput<DockerDeploymentCreateInput>(
          baseInput as Partial<DockerDeploymentCreateInput> as DockerDeploymentCreateInput,
          override,
        ),
      );
    };
    return Object.assign(create, { create });
  }
}

export class FlyDeployment extends Deployment<FlyDeploymentCreateInput, FlyDeploymentLocator> {
  static override implemented: boolean = true;

  readonly providerName = "fly";

  protected override async resolveDefaultIngressInput(params: {
    input: FlyDeploymentCreateInput;
    createResult: RuntimeCreateResult<FlyDeploymentLocator>;
  }): Promise<DeploymentIngressInput> {
    const rawEnv = process.env as Record<string, string | undefined>;
    const ingressProxyBaseUrl = (
      rawEnv.JONASLAND_E2E_INGRESS_PROXY_BASE_URL ??
      rawEnv.INGRESS_PROXY_BASE_URL ??
      DEFAULT_INGRESS_PROXY_BASE_URL
    )
      .trim()
      .replace(/\/+$/, "");
    const ingressProxyApiKey = (
      rawEnv.INGRESS_PROXY_API_TOKEN ??
      rawEnv.INGRESS_PROXY_E2E_API_TOKEN ??
      ""
    ).trim();
    const runtimeIngressUrl = await params.createResult.runtime.ingressUrl();

    return {
      publicBaseUrl: runtimeIngressUrl,
      publicBaseUrlType: "prefix",
      createIngressProxyRoutes: false,
      ingressProxyBaseUrl,
      ingressProxyApiKey,
      ingressProxyTargetUrl: runtimeIngressUrl,
    };
  }

  protected override async createRuntime(
    input: FlyDeploymentCreateInput,
  ): Promise<RuntimeCreateResult<FlyDeploymentLocator>> {
    return await flyDeploymentRuntimeCreate(input);
  }

  protected override async attachRuntime(
    locator: FlyDeploymentLocator,
  ): Promise<DeploymentRuntime> {
    return await flyDeploymentRuntimeAttach(locator);
  }

  static async create(input: FlyDeploymentCreateInput): Promise<FlyDeployment> {
    const deployment = new FlyDeployment();
    await deployment.create(input);
    return deployment;
  }

  static createWithConfig<TProvided extends Partial<FlyDeploymentCreateInput>>(
    baseInput: TProvided,
  ) {
    const create = async (
      ...args: CreateWithConfigArgs<FlyDeploymentCreateInput, TProvided>
    ): Promise<FlyDeployment> => {
      const override = args[0];
      return await FlyDeployment.create(
        mergeCreateInput<FlyDeploymentCreateInput>(
          baseInput as Partial<FlyDeploymentCreateInput> as FlyDeploymentCreateInput,
          override,
        ),
      );
    };
    return Object.assign(create, { create });
  }
}
