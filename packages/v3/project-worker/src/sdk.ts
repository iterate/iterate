// sdk.ts — THE userspace SDK surface, bundled (zod included) into every loaded processor
// isolate as `processor.js` by build-sdk.mjs. Userspace writes exactly what built-ins write:
//
//   import { StreamProcessor, defineProcessorContract, z } from "./processor.js";
//
// One contract shape, one base class, schemas everywhere (owner's call: isolates absolutely
// get zod and full contract schemas as part of the SDK).

export {
  StreamProcessor,
  type ProcessorContract,
  type ProcessorSnapshot,
  type ProcessorStream,
  type ProcessEventArgs,
  type ReduceArgs,
  type ScanWindow,
} from "./core/processor.ts";
export {
  defineProcessorContract,
  StreamEvent,
  StreamEventInput,
  jsonEqual,
} from "./core/events.ts";
export { z } from "zod";
