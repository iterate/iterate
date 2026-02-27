import { dockerDeploymentRuntime, type DeploymentRuntime } from "./docker-deployment.ts";
import { flyDeploymentRuntime } from "./fly-deployment.ts";
export type { DeploymentRuntime, SandboxFixture } from "./docker-deployment.ts";

export type ProviderName = "docker" | "fly";

export type DeploymentCommandResult = {
  exitCode: number;
  output: string;
};

export interface DeploymentConfig {
  image: string;
  name?: string;
  extraHosts?: string[];
  capAdd?: string[];
  env?: Record<string, string> | string[];
}

export interface DeploymentStartParams extends Partial<DeploymentConfig> {
  waitForReady?: boolean;
  readyTimeoutMs?: number;
}

export type DeploymentFactory<TDeployment extends Deployment = Deployment> = {
  create(params?: DeploymentStartParams): Promise<TDeployment>;
};

const EGRESS_PROCESS_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
};

function mergeConfig(base: DeploymentConfig, override?: DeploymentStartParams): DeploymentConfig {
  if (!override) return { ...base };
  return {
    image: override.image ?? base.image,
    name: override.name ?? base.name,
    extraHosts: override.extraHosts ?? base.extraHosts,
    capAdd: override.capAdd ?? base.capAdd,
    env: override.env ?? base.env,
  };
}

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

abstract class DeploymentBase implements AsyncDisposable, DeploymentRuntime {
  static implemented: boolean = false;

  protected runtime: DeploymentRuntime | null = null;
  protected state: "new" | "running" | "stopped" | "destroyed" = "new";
  private homeEnvFilePath: string | null = null;

  constructor(public readonly config: DeploymentConfig) {}

  abstract readonly providerName: ProviderName;

  protected abstract createRuntime(config: DeploymentConfig): Promise<DeploymentRuntime>;

  protected requireRuntime(): DeploymentRuntime {
    if (!this.runtime) {
      throw new Error(`${this.constructor.name} is not started`);
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

  async start(params?: DeploymentStartParams): Promise<this> {
    if (this.state === "destroyed") {
      throw new Error(`${this.constructor.name} has been destroyed`);
    }

    if (this.runtime) {
      return this;
    }

    const config = mergeConfig(this.config, params);
    this.runtime = await this.createRuntime(config);
    this.state = "running";

    if (params?.waitForReady ?? true) {
      const readyTimeoutMs = params?.readyTimeoutMs ?? 120_000;
      await this.waitForPidnapHostRoute({ timeoutMs: readyTimeoutMs });
      await this.waitForDirectHttp({
        url: "http://127.0.0.1/",
        timeoutMs: readyTimeoutMs,
      });
    }

    return this;
  }

  async restart(): Promise<void> {
    if (!this.runtime) {
      await this.start();
      return;
    }

    await this.runtime.restart();
    this.state = "running";
  }

  async stop(): Promise<void> {
    if (!this.runtime) return;

    await this.runtime[Symbol.asyncDispose]();
    this.runtime = null;
    this.state = "stopped";
  }

  async destroy(): Promise<void> {
    if (this.state === "destroyed") return;

    if (this.runtime) {
      await this.runtime[Symbol.asyncDispose]();
      this.runtime = null;
    }

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
        `TMP_FILE=\"$(mktemp ${shQuote(`${envFilePath}.tmp.XXXXXX`)})\"`,
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
    const envFilePath = await this.resolveHomeEnvFilePath();
    if (params?.externalProxyUrl) {
      await this.setEnvVars({ ITERATE_EXTERNAL_EGRESS_PROXY: params.externalProxyUrl });
    }

    await retry(async () => {
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
    }, 8);

    await this.waitForDirectHttp({
      url: "http://127.0.0.1:19000/healthz",
      timeoutMs: 120_000,
    });
  }

  async runEgressRequestViaCurl(params: {
    requestPath: string;
    payloadJson: string;
  }): Promise<{ exitCode: number; output: string }> {
    return await this.exec([
      "sh",
      "-ec",
      [
        "curl -4 -k -sS -i",
        "-H 'content-type: application/json'",
        `--data ${shQuote(params.payloadJson)}`,
        `https://api.openai.com${params.requestPath}`,
      ].join(" "),
    ]);
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
      config: this.config,
      state: this.state,
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

export abstract class Deployment extends DeploymentBase {
  static override implemented: boolean = false;
}

export class DockerDeployment extends Deployment {
  static override implemented: boolean = true;

  readonly providerName = "docker";

  protected override async createRuntime(config: DeploymentConfig): Promise<DeploymentRuntime> {
    return await dockerDeploymentRuntime(config);
  }

  static withConfig(config: DeploymentConfig): DeploymentFactory<DockerDeployment> {
    return {
      create: async (params) => {
        const deployment = new DockerDeployment(config);
        await deployment.start(params);
        return deployment;
      },
    };
  }
}

export class FlyDeployment extends Deployment {
  static override implemented: boolean = true;

  readonly providerName = "fly";

  protected override async createRuntime(config: DeploymentConfig): Promise<DeploymentRuntime> {
    return await flyDeploymentRuntime({
      image: config.image,
      name: config.name,
      env: config.env,
    });
  }

  static withConfig(config: DeploymentConfig): DeploymentFactory<FlyDeployment> {
    return {
      create: async (params) => {
        const deployment = new FlyDeployment(config);
        await deployment.start(params);
        return deployment;
      },
    };
  }
}
