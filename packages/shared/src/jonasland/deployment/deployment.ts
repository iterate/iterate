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

export interface DeploymentCreateInputCommon {
  name: string;
  env?: Record<string, string> | string[];
  waitForReady?: boolean;
  readyTimeoutMs?: number;
}

export interface DockerDeploymentCreateInput extends DeploymentCreateInputCommon {
  dockerImage: string;
  extraHosts?: string[];
  capAdd?: string[];
}

export interface FlyDeploymentCreateInput extends DeploymentCreateInputCommon {
  flyImage: string;
}

export type DeploymentLocator = DockerDeploymentLocator | FlyDeploymentLocator;

export type DeploymentOwnership = "owned" | "attached";

const EGRESS_PROCESS_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
};

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

  abstract readonly providerName: ProviderName;

  protected abstract createRuntime(
    input: TCreateInput,
  ): Promise<RuntimeCreateResult<TDeploymentLocator>>;
  protected abstract attachRuntime(locator: TDeploymentLocator): Promise<DeploymentRuntime>;

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

  protected clearLocalState(): void {
    this.runtime = null;
    this.deploymentLocator = null;
    this.homeEnvFilePath = null;
    this.ownership = null;
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
    this.state = "running";

    if (params?.waitForReady ?? true) {
      const readyTimeoutMs = params?.readyTimeoutMs ?? 120_000;
      try {
        await this.waitForPidnapHostRoute({ timeoutMs: readyTimeoutMs });
        await this.waitForDirectHttp({
          url: "http://127.0.0.1/",
          timeoutMs: readyTimeoutMs,
        });
      } catch (error) {
        await this.destroy().catch(() => {});
        throw error;
      }
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

    if (this.runtime && this.ownership === "owned") {
      await this.runtime[Symbol.asyncDispose]();
    }

    this.clearLocalState();
    this.state = "destroyed";
  }

  async ingressUrl() {
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
    const ingressBaseUrl = await this.ingressUrl();
    const requestUrl = new URL(request.url);
    const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, ingressBaseUrl);

    const method = request.method.toUpperCase();
    const headers = new Headers(request.headers);
    headers.set("host", host);
    headers.delete("content-length");

    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : Buffer.from(await request.clone().arrayBuffer());

    if (body !== undefined) {
      headers.set("content-length", body.byteLength.toString());
    }

    return await fetch(targetUrl, {
      method,
      headers,
      body,
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
        `mv \"$TMP_FILE\" ${shQuote(envFilePath)}`,
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

        const definition = {
          command: existing?.definition.command ?? "/opt/pidnap/node_modules/.bin/tsx",
          args: existing?.definition.args ?? ["/opt/services/egress-service/src/server.ts"],
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

    const homeResult = await this.exec(["sh", "-ec", 'printf %s "$HOME"']);
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
