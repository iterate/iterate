import { DurableObject } from "cloudflare:workers";
import { RpcTarget, newWorkersRpcResponse } from "capnweb";
import { LiveState, LiveStateRpcTarget } from "iterate/sdk/capnweb";
import { readSqliteAlchemyOutput } from "./alchemy/sqlite-state.ts";
import { ENVIRONMENT_STACK_NAME, runEnvironmentAlchemy } from "./alchemy/worker-runtime.ts";
import { makeCloudflareControlPlane } from "./cloudflare-control-plane.ts";
import {
  getEnvironment,
  isCompiledEnvironmentStage,
  type CompiledEnvironment,
} from "./environments.ts";
import type { Env } from "./env.ts";
import {
  assertEnvironmentDestroyAllowed,
  EnvironmentState,
  AlchemyResources,
  parsePersistedEnvironmentState,
  persistedEnvironmentState,
  reconcileEnvironmentState,
  recoverInterruptedEnvironmentState,
  type AlchemyResources as AlchemyResourcesType,
  type EnvironmentApi,
  type EnvironmentStage,
  type PersistedEnvironmentState,
  type ResourceProgress,
} from "./state.ts";

export class EnvironmentDurableObject extends DurableObject<Env> {
  readonly #environment: CompiledEnvironment;
  readonly #stage: EnvironmentStage;
  readonly #live: LiveState<EnvironmentState>;
  #operation:
    | {
        abort: AbortController;
        id: string;
      }
    | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const stage = ctx.id.name;
    if (stage === undefined || !isCompiledEnvironmentStage(stage)) {
      throw new Error(`Environment Durable Object requires a compiled stage, got ${stage}.`);
    }
    this.#stage = stage;
    this.#environment = getEnvironment(stage);
    ctx.storage.sql.exec(`
      create table if not exists environment_state (
        singleton integer primary key check (singleton = 1),
        value text not null
      )
    `);
    const persisted = ctx.storage.sql
      .exec<{ value: string }>("select value from environment_state where singleton = 1")
      .toArray()[0];
    const persistedState: PersistedEnvironmentState =
      persisted === undefined
        ? { stage, lifecycle: "empty", progress: [] }
        : parsePersistedEnvironmentState(persisted.value, stage);
    const recovered = recoverInterruptedEnvironmentState(persistedState, new Date().toISOString());
    let state: EnvironmentState;
    try {
      state = reconcileEnvironmentState(recovered, this.#readResources());
    } catch (error) {
      state = {
        ...recovered,
        lifecycle: "failed",
        lastError:
          "Canonical Alchemy stack output is invalid; deploy or destroy the environment to replace it. " +
          (error instanceof Error ? error.message : String(error)),
      };
    }
    this.#live = new LiveState(state);
    if (persisted !== undefined) this.#setState(state);
  }

  #readResources(): AlchemyResourcesType | undefined {
    const output = readSqliteAlchemyOutput(this.ctx.storage, {
      stack: ENVIRONMENT_STACK_NAME,
      stage: this.#stage,
    });
    if (output === undefined) return undefined;
    const resources = AlchemyResources.parse(output);
    if (resources.stage !== this.#stage) {
      throw new Error(`Alchemy output belongs to ${resources.stage}, not ${this.#stage}.`);
    }
    return resources;
  }

  #setState(state: EnvironmentState): void {
    const validated = EnvironmentState.parse(state);
    this.ctx.storage.sql.exec(
      `insert into environment_state (singleton, value)
       values (1, ?)
       on conflict (singleton) do update set value = excluded.value`,
      JSON.stringify(persistedEnvironmentState(validated)),
    );
    this.#live.setState(validated);
  }

  #updateState(update: (state: EnvironmentState) => EnvironmentState): void {
    this.#setState(update(this.#live.getState()));
  }

  #run(
    lifecycle: "checking" | "deploying" | "destroying",
    operation: (signal: AbortSignal) => Promise<void>,
    operationId: string = crypto.randomUUID(),
  ): Promise<void> {
    if (this.#operation !== undefined) {
      throw new Error(
        `${this.#stage} is already ${this.#live.getState().lifecycle}; concurrent lifecycle operations are refused.`,
      );
    }
    const startedAt = new Date().toISOString();
    this.#setState({
      ...this.#live.getState(),
      lifecycle,
      operationStartedAt: startedAt,
      operationFinishedAt: undefined,
      lastError: undefined,
      progress: [],
    });
    const abort = new AbortController();
    const running = Promise.resolve()
      .then(() => operation(abort.signal))
      .then(() => {
        const current = this.#live.getState();
        const resources = this.#readResources();
        this.#setState({
          ...current,
          lifecycle: resources === undefined ? "empty" : "ready",
          operationFinishedAt: new Date().toISOString(),
          resources,
        });
      })
      .catch((error: unknown) => {
        let resources: AlchemyResourcesType | undefined;
        let failure: unknown = abort.signal.aborted
          ? (abort.signal.reason ?? new Error(`Environment ${lifecycle} was cancelled.`))
          : error;
        try {
          resources = this.#readResources();
        } catch (outputError) {
          failure = new AggregateError(
            [failure, outputError],
            `${this.#stage} ${lifecycle} failed and its canonical Alchemy output could not be read.`,
          );
        }
        this.#updateState((current) => ({
          ...current,
          lifecycle: "failed",
          operationFinishedAt: new Date().toISOString(),
          lastError: failure instanceof Error ? failure.message : String(failure),
          resources,
        }));
        throw failure;
      })
      .finally(() => {
        if (this.#operation?.id === operationId) {
          this.#operation = undefined;
        }
      });
    this.#operation = { abort, id: operationId };
    this.ctx.waitUntil(running);
    return running;
  }

  cancel(operationId: string): boolean {
    const operation = this.#operation;
    if (operation?.id !== operationId) return false;
    operation.abort.abort(new Error(`Environment operation ${operationId} cancelled by caller.`));
    return true;
  }

  #publishProgress(progress: ResourceProgress): void {
    this.#updateState((current) => ({
      ...current,
      progress: [...current.progress.filter(({ id }) => id !== progress.id), progress],
    }));
  }

  async #apiToken(): Promise<string> {
    return this.#environment.account === "production"
      ? await this.env.PRODUCTION_CLOUDFLARE_API_TOKEN.get()
      : await this.env.PREVIEW_CLOUDFLARE_API_TOKEN.get();
  }

  liveState(): LiveStateRpcTarget<EnvironmentState> {
    return new LiveStateRpcTarget(this.#live);
  }

  status(): EnvironmentState {
    return this.#live.getState();
  }

  deploy(): Promise<void> {
    return this.#run("deploying", async (signal) => {
      const apiToken = await this.#apiToken();
      await runEnvironmentAlchemy({
        accountId: this.#environment.accountId,
        apiToken,
        environment: this.#environment,
        operation: "deploy",
        signal,
        storage: this.ctx.storage,
        onProgress: (progress) => this.#publishProgress(progress),
      });
      const resources = this.#readResources();
      if (resources === undefined) {
        throw new Error(`Alchemy deploy for ${this.#stage} produced no stack output.`);
      }
    });
  }

  destroy(
    confirmation: EnvironmentStage,
    allowProductionDestroy: boolean,
    operationId?: string,
  ): Promise<void> {
    assertEnvironmentDestroyAllowed({
      browserSession: allowProductionDestroy,
      confirmation,
      stage: this.#stage,
    });
    return this.#run(
      "destroying",
      async (signal) => {
        const apiToken = await this.#apiToken();
        signal.throwIfAborted();
        await makeCloudflareControlPlane({
          accountId: this.#environment.accountId,
          apiToken,
          onProgress: (progress) => this.#publishProgress(progress),
          signal,
        }).destroyWranglerResources({
          workerNames: this.#environment.workerNames,
          osWorkerName:
            this.#environment.kind === "platform" ? this.#environment.osWorkerName : undefined,
        });
        signal.throwIfAborted();
        await runEnvironmentAlchemy({
          accountId: this.#environment.accountId,
          apiToken,
          environment: this.#environment,
          operation: "destroy",
          signal,
          storage: this.ctx.storage,
          onProgress: (progress) => this.#publishProgress(progress),
        });
        if (this.#readResources() !== undefined) {
          throw new Error(`Alchemy destroy for ${this.#stage} retained its stack output.`);
        }
      },
      operationId,
    );
  }

  check(): Promise<void> {
    return this.#run("checking", async (signal) => {
      const resources = this.#readResources();
      if (resources === undefined) {
        throw new Error(`${this.#stage} has no deployed Alchemy resource manifest.`);
      }
      this.#updateState((current) => ({ ...current, resources }));
      const apiToken = await this.#apiToken();
      await makeCloudflareControlPlane({
        accountId: this.#environment.accountId,
        apiToken,
        signal,
      }).assertResourcesExist(resources, this.#environment.workerNames);
    });
  }

  override fetch(request: Request): Response | Promise<Response> {
    return newWorkersRpcResponse(
      request,
      new EnvironmentSession(
        this,
        request.headers.get("x-iterate-env-manager-browser-session") === "1",
      ),
    );
  }
}

class EnvironmentSession extends RpcTarget implements EnvironmentApi {
  constructor(
    private readonly environment: EnvironmentDurableObject,
    private readonly browserSession: boolean,
  ) {
    super();
  }

  get liveState(): LiveStateRpcTarget<EnvironmentState> {
    return this.environment.liveState();
  }

  async status(): Promise<EnvironmentState> {
    return this.environment.status();
  }

  async deploy(): Promise<void> {
    await this.environment.deploy();
  }

  async destroy(confirmation: EnvironmentStage, operationId?: string): Promise<void> {
    await this.environment.destroy(confirmation, this.browserSession, operationId);
  }

  async cancel(operationId: string): Promise<boolean> {
    return this.environment.cancel(operationId);
  }

  async check(): Promise<void> {
    await this.environment.check();
  }
}
