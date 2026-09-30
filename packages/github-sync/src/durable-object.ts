// github-sync/durable-object.ts — the loadable host: the processor, handed this facet's itx.
import { StreamProcessorDurableObject } from "iterate/sdk";
import type { ProcessorState } from "iterate/stream/processor";
import type { GithubSyncContract } from "./contract.ts";
import { GithubSyncProcessor } from "./processor.ts";

export class GithubSyncDurableObject extends StreamProcessorDurableObject<
  ProcessorState<typeof GithubSyncContract>
> {
  processor = new GithubSyncProcessor(() => this.getItx());
}
