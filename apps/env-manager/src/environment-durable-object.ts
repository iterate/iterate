import { DurableObject } from "cloudflare:workers";
import { RpcTarget, newWorkersRpcResponse } from "capnweb";
import { LiveState, LiveStateRpcTarget } from "iterate/sdk/capnweb";
import { envManagerEnv } from "../../../envs.ts";
import { runEnvironmentAlchemy } from "./alchemy/worker-runtime.ts";
import { makeCloudflareControlPlane } from "./cloudflare-control-plane.ts";
import { getPreviewEnvironment, isCompiledPreviewStage } from "./environments.ts";
import type { Env } from "./env.ts";
import {
  EnvironmentState,
  type EnvironmentApi,
  type PreviewStage,
  type ResourceProgress,
} from "./state.ts";

export class EnvironmentDurableObject extends DurableObject<Env> {
  readonly #stage: PreviewStage;
  readonly #live: LiveState<EnvironmentState>;
  #operation: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const stage = ctx.id.name;
    if (stage === undefined || !isCompiledPreviewStage(stage)) {
      throw new Error(
        `Environment Durable Object requires a compiled preview stage, got ${stage}.`,
      );
    }
    this.#stage = stage;
    ctx.storage.sql.exec(`
      create table if not exists environment_state (
        singleton integer primary key check (singleton = 1),
        value text not null
      )
    `);
    const persisted = ctx.storage.sql
      .exec<{ value: string }>("select value from environment_state where singleton = 1")
      .toArray()[0];
    const state =
      persisted === undefined
        ? { stage, lifecycle: "empty" as const, progress: [] }
        : EnvironmentState.parse(JSON.parse(persisted.value) as unknown);
    this.#live = new LiveState(state);
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
    return running;
  }

  #publishProgress(progress: ResourceProgress): void {
    this.#updateState((current) => ({
      ...current,
      progress: [...current.progress.filter(({ id }) => id !== progress.id), progress],
    }));
  }

  liveState(): LiveStateRpcTarget<EnvironmentState> {
    return new LiveStateRpcTarget(this.#live);
  }

  status(): EnvironmentState {
    return this.#live.getState();
  }

  deploy(): Promise<void> {
    return this.#run("deploying", async () => {
      const apiToken = await this.env.CLOUDFLARE_API_TOKEN.get();
      const resources = await runEnvironmentAlchemy({
        accountId: envManagerEnv.cloudflareAccountId,
        apiToken,
        operation: "deploy",
        sql: this.ctx.storage.sql,
        stage: this.#stage,
        onProgress: (progress) => this.#publishProgress(progress),
      });
      if (resources === undefined) {
        throw new Error(`Alchemy deploy for ${this.#stage} produced no stack output.`);
      }
      this.#updateState((current) => ({ ...current, resources }));
    });
  }

  destroy(): Promise<void> {
    return this.#run("destroying", async () => {
      const apiToken = await this.env.CLOUDFLARE_API_TOKEN.get();
      const environment = getPreviewEnvironment(this.#stage);
      const cloudflare = makeCloudflareControlPlane({
        accountId: envManagerEnv.cloudflareAccountId,
        apiToken,
      });
      await cloudflare.destroyWranglerEnvironment({
        osWorkerName: environment.osWorkerName,
        previewSlot: environment.slot,
      });
      await runEnvironmentAlchemy({
        accountId: envManagerEnv.cloudflareAccountId,
        apiToken,
        operation: "destroy",
        sql: this.ctx.storage.sql,
        stage: this.#stage,
        onProgress: (progress) => this.#publishProgress(progress),
      });
      this.#updateState((current) => ({ ...current, resources: undefined }));
    });
  }

  check(): Promise<void> {
    return this.#run("checking", async () => {
      const resources = this.#live.getState().resources;
      if (resources === undefined) return;
      const apiToken = await this.env.CLOUDFLARE_API_TOKEN.get();
      await makeCloudflareControlPlane({
        accountId: envManagerEnv.cloudflareAccountId,
        apiToken,
      }).assertResourcesExist(resources);
    });
  }

  override fetch(request: Request): Response | Promise<Response> {
    return newWorkersRpcResponse(request, new EnvironmentSession(this));
  }
}

class EnvironmentSession extends RpcTarget implements EnvironmentApi {
  constructor(private readonly environment: EnvironmentDurableObject) {
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

  async destroy(): Promise<void> {
    await this.environment.destroy();
  }

  async check(): Promise<void> {
    await this.environment.check();
  }
}
