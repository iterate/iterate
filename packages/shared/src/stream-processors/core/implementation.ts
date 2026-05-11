import { implementProcessor } from "../stream-processor.ts";
import { CoreProcessorContract } from "./contract.ts";

/**
 * Core processor implementation.
 *
 * The core contract owns shared lifecycle event schemas, but today it has no
 * side effects of its own. Processors that want standard registration behavior
 * compose `standardProcessorBehavior` into their own reducer and hook.
 */
export function createCoreProcessor() {
  return implementProcessor(CoreProcessorContract, {});
}
