import { DurableObject } from "cloudflare:workers";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/os/src/domains/streams/engine/workers/stream-processor-host.ts";
import type { Env } from "../../env.ts";
import { parseDurableObjectName } from "../durable-object-names.ts";
import { fakeRepoWorkerSource } from "./fake-repo-sources.ts";
import { RepoProcessor, RepoProcessorContract } from "./repo-processor.ts";

export class RepoDurableObject extends DurableObject<Env> {
  readonly name = parseDurableObjectName(this.ctx.id.name!);

  host = createStreamProcessorHost(this.ctx);

  repoProcessor = this.host.add(
    RepoProcessorContract.slug,
    (deps) => new RepoProcessor({ ...deps }),
  );

  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.host.requestStreamSubscription(args);
  }

  getWorkerSource(args: { path: string }) {
    return fakeRepoWorkerSource(args);
  }

  whoami(): string {
    return `repo ${this.name.projectId}:${this.name.path}`;
  }
}
