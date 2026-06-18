import { DurableObject, env, RpcTarget } from "cloudflare:workers";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/os/src/domains/streams/engine/workers/stream-processor-host.ts";
import type { Env } from "../../env.ts";
import type { RepoRpc } from "../../itx-types.ts";
import { formatDurableObjectName, parseDurableObjectName } from "../durable-object-names.ts";
import { fakeRepoWorkerSource } from "./fake-repo-sources.ts";
import { RepoProcessor, RepoProcessorContract } from "./repo-processor.ts";

export class RepoDurableObject extends DurableObject<Env> implements RepoRpc {
  readonly #name = parseDurableObjectName(this.ctx.id.name!);
  readonly #host = createStreamProcessorHost(this.ctx);
  readonly #stream = this.ctx.exports.StreamDurableObject.getByName(this.ctx.id.name!);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#host.add(RepoProcessorContract.slug, (deps) => new RepoProcessor(deps));
  }

  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.#host.requestStreamSubscription(args);
  }

  getWorkerSource(args: { path: string }) {
    return fakeRepoWorkerSource(args);
  }

  async create(input: Record<string, unknown> = {}) {
    await this.#stream.append({
      event: {
        type: "events.iterate.com/repo/create-requested",
        payload: input,
      },
    });
    return await this.#stream.waitForEvent({
      eventTypes: ["events.iterate.com/repo/created"],
      predicate: () => true,
      timeoutMs: 5_000,
    });
  }

  whoami(): string {
    return `repo ${this.#name.projectId}:${this.#name.path}`;
  }
}

export class RepoRpcTarget extends RpcTarget implements RepoRpc {
  constructor(readonly props: { path: string; projectId: string }) {
    super();
  }

  create(input: Record<string, unknown> = {}) {
    return this.#stub().create(input);
  }

  whoami() {
    return this.#stub().whoami();
  }

  #stub() {
    return env.REPO.getByName(formatDurableObjectName(this.props));
  }
}
