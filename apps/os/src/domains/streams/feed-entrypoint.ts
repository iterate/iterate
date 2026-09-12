import {
  ProcessorFacet,
  type ProcessorFacetHost,
  type ProcessorFacetIdentity,
} from "iterate/processors/cloudflare";
import { createJsonByteLength } from "@iterate-com/shared/json-byte-length";
import { trustedInternalAuthContext } from "../../auth.ts";
import { workerVersion, type Env } from "../../env.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import { createFeedPublicationStore, FeedProcessor } from "./feed-processor.ts";
import { FeedProcessorContract } from "./feed-contract.ts";

const feedStateByteLength = createJsonByteLength();
const feedReductionCache = {
  shouldCacheReduction: (state: unknown) => feedStateByteLength(state) <= 512 * 1024,
  initialState: () => FeedProcessorContract.stateSchema.parse({}),
};

/** One presentation owner per stream, independent of the stream's domain processors. */
export class FeedFacet extends ProcessorFacet<Env> {
  protected parentAlarms({ parentName }: ProcessorFacetIdentity) {
    return this.env.STREAM.getByName(parentName);
  }

  protected createHost(identity: ProcessorFacetIdentity): ProcessorFacetHost {
    const stream = new StreamRpcTarget({
      auth: trustedInternalAuthContext(),
      projectId: identity.projectId,
      path: identity.path,
    });
    let presentation: (() => Record<string, unknown>) | undefined;
    return {
      stream,
      version: workerVersion(this.env),
      getLiveState: () => {
        if (!presentation) throw new Error("feed processor has not been registered");
        return presentation();
      },
      registerProcessors: (registry) => {
        const processor = new FeedProcessor({
          stream,
          projectId: identity.projectId,
          path: identity.path,
          publications: createFeedPublicationStore(this.ctx.storage.sql, (closure) =>
            this.ctx.storage.transactionSync(closure),
          ),
          refreshLive: () => registry.refreshLive(),
        });
        registry.register(processor, {
          resetForStream: () => processor.resetForStream(),
          reductionCache: feedReductionCache,
        });
        const reads = registry.reads(processor);
        presentation = () =>
          processor.presentation(reads.currentState, reads.currentStreamId ?? null);
      },
    };
  }
}
