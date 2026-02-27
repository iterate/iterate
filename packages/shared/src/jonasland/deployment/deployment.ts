export type DeploymentFetcher = (request: Request) => Promise<Response>;

export type SerializablePrimitive = string | number | boolean | null;
export type SerializableValue =
  | SerializablePrimitive
  | SerializableValue[]
  | { [key: string]: SerializableValue };
export type SerializableObject = { [key: string]: SerializableValue };

export interface DeploymentSharedConfig {
  provider: string;
  name?: string;
  image?: string;
  env?: Record<string, string>;
  externalEgressProxyURL?: string | null;
}

/**
 * Compose a single serializable config shape with:
 * - shared fields (name/image/env/externalEgressProxyURL)
 * - provider discriminator (`provider`)
 * - provider-specific top-level fields (joined, not nested)
 */
export type DeploymentConfigVariant<
  TProvider extends string,
  TProviderSpecific extends SerializableObject = SerializableObject,
  TShared extends SerializableObject = SerializableObject,
> = DeploymentSharedConfig & TShared & TProviderSpecific & { provider: TProvider };

export type DeploymentConfig = DeploymentConfigVariant<string>;

export function defineDeploymentConfigs<const T extends readonly DeploymentConfig[]>(
  configs: T,
): T {
  return configs;
}

export type ProviderConfigMap = Record<string, SerializableObject>;

export type DeploymentConfigFromMap<
  TProviderMap extends ProviderConfigMap,
  TShared extends SerializableObject = SerializableObject,
> = {
  [TProvider in keyof TProviderMap & string]: DeploymentConfigVariant<
    TProvider,
    TProviderMap[TProvider],
    TShared
  >;
}[keyof TProviderMap & string];

export type DeploymentProviderFactoryMap<
  TProviderMap extends ProviderConfigMap,
  TProviderInstance,
  TShared extends SerializableObject = SerializableObject,
> = {
  [TProvider in keyof TProviderMap & string]: (
    config: DeploymentConfigVariant<TProvider, TProviderMap[TProvider], TShared>,
  ) => TProviderInstance;
};

export interface DeploymentRuntime {
  fetcher: DeploymentFetcher;
  restart(): Promise<void>;
  destroy(): Promise<void>;
  status(): Promise<string>;
}

export interface PidnapBootstrapClient {
  health(): Promise<unknown>;
  processes: {
    waitForRunning(input: {
      target: string;
      timeoutMs?: number;
      pollIntervalMs?: number;
      includeLogs?: boolean;
      logTailLines?: number;
    }): Promise<{
      state: string;
      logs?: string;
    }>;
  };
}

export interface BootstrapClients {
  pidnap: PidnapBootstrapClient;
}

export interface BootstrapContext<TInput, TRuntime extends DeploymentRuntime> {
  input: TInput;
  runtime: TRuntime;
}

export interface DeploymentProviderOptions {
  caddyHealthTimeoutMs?: number;
  pidnapHealthTimeoutMs?: number;
  serviceReadyTimeoutMs?: number;
  bootstrapPollIntervalMs?: number;
  bootstrapServices?: string[];
}

const DEFAULT_OPTIONS: Required<DeploymentProviderOptions> = {
  caddyHealthTimeoutMs: 180_000,
  pidnapHealthTimeoutMs: 120_000,
  serviceReadyTimeoutMs: 120_000,
  bootstrapPollIntervalMs: 250,
  bootstrapServices: ["registry", "events"],
};

export abstract class DeploymentProvider<
  TOpts extends object,
  TInput,
  TRuntime extends DeploymentRuntime,
> {
  protected readonly bootstrapOpts: Required<DeploymentProviderOptions>;

  protected constructor(
    protected readonly opts: TOpts,
    bootstrapOpts?: DeploymentProviderOptions,
  ) {
    this.bootstrapOpts = {
      ...DEFAULT_OPTIONS,
      ...(bootstrapOpts ?? {}),
      bootstrapServices:
        bootstrapOpts?.bootstrapServices && bootstrapOpts.bootstrapServices.length > 0
          ? bootstrapOpts.bootstrapServices
          : DEFAULT_OPTIONS.bootstrapServices,
    };
  }

  /**
   * Provider-specific infra provisioning.
   */
  protected abstract provision(input: TInput): Promise<TRuntime>;

  /**
   * Build bootstrap clients from the runtime fetcher.
   */
  protected abstract buildBootstrapClients(
    ctx: BootstrapContext<TInput, TRuntime>,
  ): Promise<BootstrapClients>;

  /**
   * Return the health endpoint request used to confirm ingress/Caddy readiness.
   * This should target your deployment ingress health route.
   */
  protected abstract buildCaddyHealthRequest(ctx: BootstrapContext<TInput, TRuntime>): Request;

  protected async beforeBootstrap(
    _ctx: BootstrapContext<TInput, TRuntime>,
    _clients: BootstrapClients,
  ): Promise<void> {}

  protected async afterBootstrap(
    _ctx: BootstrapContext<TInput, TRuntime>,
    _clients: BootstrapClients,
  ): Promise<void> {}

  async create(input: TInput): Promise<TRuntime> {
    const runtime = await this.provision(input);
    const ctx: BootstrapContext<TInput, TRuntime> = {
      input,
      runtime,
    };

    try {
      const clients = await this.buildBootstrapClients(ctx);

      await this.beforeBootstrap(ctx, clients);
      await this.waitForCaddyHealthy(ctx);
      await this.waitForPidnapHealthy(clients.pidnap);
      await this.waitForCoreServices(clients.pidnap);
      await this.afterBootstrap(ctx, clients);

      return runtime;
    } catch (error) {
      await runtime.destroy().catch(() => {});
      throw error;
    }
  }

  private async waitForCaddyHealthy(ctx: BootstrapContext<TInput, TRuntime>): Promise<void> {
    const deadline = Date.now() + this.bootstrapOpts.caddyHealthTimeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        const request = this.buildCaddyHealthRequest(ctx);
        const response = await ctx.runtime.fetcher(request);
        if (response.ok) return;
        lastError = new Error(`caddy health returned ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.bootstrapOpts.bootstrapPollIntervalMs),
      );
    }

    throw new Error("timed out waiting for caddy health", { cause: lastError });
  }

  private async waitForPidnapHealthy(pidnap: PidnapBootstrapClient): Promise<void> {
    const deadline = Date.now() + this.bootstrapOpts.pidnapHealthTimeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        await pidnap.health();
        return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.bootstrapOpts.bootstrapPollIntervalMs),
      );
    }

    throw new Error("timed out waiting for pidnap health", { cause: lastError });
  }

  private async waitForCoreServices(pidnap: PidnapBootstrapClient): Promise<void> {
    await Promise.all(
      this.bootstrapOpts.bootstrapServices.map(async (serviceName) => {
        const response = await pidnap.processes.waitForRunning({
          target: serviceName,
          timeoutMs: this.bootstrapOpts.serviceReadyTimeoutMs,
          pollIntervalMs: this.bootstrapOpts.bootstrapPollIntervalMs,
          includeLogs: true,
          logTailLines: 120,
        });

        if (response.state !== "running") {
          throw new Error(
            `service ${serviceName} did not reach running state (state=${response.state})\n${response.logs ?? ""}`,
          );
        }
      }),
    );
  }
}
