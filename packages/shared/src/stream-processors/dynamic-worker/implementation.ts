import { implementProcessor } from "../stream-processor.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import { DynamicWorkerProcessorContract } from "./contract.ts";

/**
 * Side-effect-light dynamic worker processor implementation.
 *
 * Launching configured workers is intentionally runner-owned for now. The
 * shared processor records durable config and registers its contract. A
 * Cloudflare, Node, or future sandbox runner can observe this reduced state and
 * decide how to materialize runtime worker instances.
 */
export function createDynamicWorkerProcessor() {
  return implementProcessor(DynamicWorkerProcessorContract, {
    async afterAppend({ state, streamApi }) {
      await standardProcessorBehavior.afterAppend({
        contract: DynamicWorkerProcessorContract,
        state,
        streamApi,
      });
    },
  });
}
