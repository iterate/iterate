import { DurableObject } from "cloudflare:workers";
import { RpcTarget, newWorkersRpcResponse } from "capnweb";
import { LiveState, LiveStateRpcTarget } from "iterate/sdk/capnweb";
import { runEnvironmentAlchemy } from "./alchemy/worker-runtime.ts";
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
  parsePersistedEnvironmentState,
  recoverInterruptedEnvironmentState,
  type EnvironmentApi,
  type EnvironmentStage,
  type ResourceProgress,
} from "./state.ts";

export class EnvironmentDurableObject extends DurableObject<Env> {
  readonly #environment: CompiledEnvironment;
  readonly #stage: EnvironmentStage;
  readonly #live: LiveState<EnvironmentState>;
  #operation: Promise<void> | undefined;

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
    const persistedState: EnvironmentState =
      persisted === undefined
        ? { stage, lifecycle: "empty", progress: [] }
        : parsePersistedEnvironmentState(persisted.value, stage);
    const state = recoverInterruptedEnvironmentState(persistedState, new Date().toISOString());
    this.#live = new LiveState(state);
    if (persisted !== undefined) this.#setState(state);
  }

  #setState(state: EnvironmentState): void {
    const validated = EnvironmentState.parse(state);
    this.ctx.storage.sql.exec(
      `insert into environment_state (singleton, value)
       values (1, ?)
       on conflict (singleton) do update set value = excluded.value`,
      JSON.stringify(validated),
    );
    this.#live.setState(validated);
  }

  #updateState(update: (state: EnvironmentState) => EnvironmentState): void {
    this.#setState(update(this.#live.getState()));
  }

  #run(
    lifecycle: "checking" | "deploying" | "destroying",
    operation: () => Promise<void>,
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
    const running = operation()
      .then(() => {
        const current = this.#live.getState();
        this.#setState({
          ...current,
          lifecycle: current.resources === undefined ? "empty" : "ready",
          operationFinishedAt: new Date().toISOString(),
        });
      })
      .catch((error: unknown) => {
        this.#updateState((current) => ({
          ...current,
          lifecycle: "failed",
          operationFinishedAt: new Date().toISOString(),
          lastError: error instanceof Error ? error.message : String(error),
        }));
        throw error;
      })
      .finally(() => {
        this.#operation = undefined;
      });
    this.#operation = running;
    this.ctx.waitUntil(running);
    return running;
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
    return this.#run("deploying", async () => {
      const apiToken = await this.#apiToken();
      const resources = await runEnvironmentAlchemy({
        accountId: this.#environment.accountId,
        apiToken,
        environment: this.#environment,
        operation: "deploy",
        storage: this.ctx.storage,
        onProgress: (progress) => this.#publishProgress(progress),
      });
      if (resources === undefined) {
        throw new Error(`Alchemy deploy for ${this.#stage} produced no stack output.`);
      }
      this.#updateState((current) => ({ ...current, resources }));
    });
  }

  destroy(confirmation: EnvironmentStage, allowProductionDestroy: boolean): Promise<void> {
    assertEnvironmentDestroyAllowed({
      browserSession: allowProductionDestroy,
      confirmation,
      stage: this.#stage,
    });
    return this.#run("destroying", async () => {
      const apiToken = await this.#apiToken();
      await makeCloudflareControlPlane({
        accountId: this.#environment.accountId,
        apiToken,
      }).destroyWranglerResources({
        workerNames: this.#environment.workerNames,
        osWorkerName:
          this.#environment.kind === "platform" ? this.#environment.osWorkerName : undefined,
      });
      await runEnvironmentAlchemy({
        accountId: this.#environment.accountId,
        apiToken,
        environment: this.#environment,
        operation: "destroy",
        storage: this.ctx.storage,
        onProgress: (progress) => this.#publishProgress(progress),
      });
      this.#updateState((current) => ({ ...current, resources: undefined }));
    });
  }

  check(): Promise<void> {
    return this.#run("checking", async () => {
      const resources = this.#live.getState().resources;
      if (resources === undefined) {
        throw new Error(`${this.#stage} has no deployed Alchemy resource manifest.`);
      }
      const apiToken = await this.#apiToken();
      await makeCloudflareControlPlane({
        accountId: this.#environment.accountId,
        apiToken,
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

  async destroy(confirmation: EnvironmentStage): Promise<void> {
    await this.environment.destroy(confirmation, this.browserSession);
  }

  async check(): Promise<void> {
    await this.environment.check();
  }
}
